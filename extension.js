'use strict';

/**
 * Background Profile Sync
 * ---------------------------------------------------------------------------
 * VS Code 的「配置文件(profile)」只切换 settings.json，而背景图是注入到安装
 * 目录里全局唯一的 workbench.html 的，所以切换 profile 时背景不会跟着变。
 *
 * 两种工作模式（设置 bgProfileSync.syncMode）：
 *
 *  loader（默认，v2 起）—— 零重载：
 *    html 里只装一个稳定的「加载器」脚本（含「安装似乎损坏」提示抑制 + 主题变量），
 *    扩展把当前 profile 的 CSS 编译成 JSON 写进安装目录，加载器定时 fetch 并套到
 *    <style> 上。切 profile / 改配置只改 JSON，html 不再变动，**不需要重载窗口**。
 *    （实测：renderer 没有 require，但 fetch 能读 app 目录内的文件；
 *      `<style>.textContent` 可用，Trusted Types 只拦 <script>。）
 *
 *  html（旧行为，兜底）—— 每次最多一次重载：
 *    直接把配置生成/委托给 shalldie.background 的注入块写进 html。
 *    用于 background.editor 段（loader 不渲染它），或将来 VS Code 收紧协议时兜底。
 *
 * 写入安全：html 写入前做完整性自检，先写临时文件再原子替换，旧 html 备份到
 * globalStorage（最多 10 份）；写失败只警告一次。
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const sync = require('./sync');

const BG_EXT_ID = 'shalldie.background';
const LAST_ATTEMPT_KEY = 'bgProfileSync.lastAttempt';
const ATTEMPT_WINDOW_MS = 60 * 1000;
const DOC_URL = 'https://github.com/shalldie/vscode-background/blob/master/docs/common-issues.md#read-only-file-system';

/** @type {import('vscode').OutputChannel | undefined} */
let output;
let warnedWriteError = false;

function getOutput(context) {
  if (!output) {
    output = vscode.window.createOutputChannel('Background Profile Sync');
    context.subscriptions.push(output);
  }
  return output;
}

function log(context, message) {
  getOutput(context).appendLine('[' + new Date().toISOString().slice(11, 19) + '] ' + message);
}

async function activate(context) {
  getOutput(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('bgProfileSync.syncNow', async () => {
      const result = await runSync(context, true);
      vscode.window.showInformationMessage('Background Profile Sync: ' + result);
    }),
    vscode.commands.registerCommand('bgProfileSync.diagnose', async () => {
      await diagnose(context);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('background')) {
        return;
      }
      onBackgroundConfigChanged(context).catch((error) => {
        log(context, '配置变化后刷新失败: ' + (error && error.message ? error.message : error));
      });
    })
  );

  try {
    await runSync(context, false);
  } catch (error) {
    log(context, '同步失败: ' + (error && error.stack ? error.stack : error));
  }
}

function deactivate() {}

/** 配置变了：loader 模式下直接重写 JSON（不重载）；html 模式让标记失效 */
async function onBackgroundConfigChanged(context) {
  const options = vscode.workspace.getConfiguration('bgProfileSync');
  if (options.get('enabled') === false || vscode.env.appHost !== 'desktop') {
    return;
  }
  const mode = resolveMode(options);
  const state = sync.readState(vscode.workspace.getConfiguration('background'));
  const targets = sync.loaderTargets(vscode.env.appRoot);
  if (mode === 'loader' && targets && !state.editorImages.length) {
    const emptyBehavior = options.get('emptyBehavior') === 'keep' ? 'keep' : 'clear';
    if (sync.assess(fs.readFileSync(targets.htmlPath, 'utf8'), state).unresolved) {
      log(context, '配置变化：背景图路径无法解析，保持现状');
      return;
    }
    const changed = writePayloadFor(context, targets.payloadPath, state, emptyBehavior);
    log(context, '配置变化：payload ' + (changed ? '已更新（加载器会在 ~120ms 内应用）' : '无变化'));
    return;
  }
  await forgetMarker(context);
}

function resolveMode(options) {
  return options.get('syncMode') === 'html' ? 'html' : 'loader';
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {boolean} force 手动触发时忽略「已同步」判断
 * @returns {Promise<string>} 人类可读的结果
 */
async function runSync(context, force) {
  const options = vscode.workspace.getConfiguration('bgProfileSync');
  if (options.get('enabled') === false) {
    return '已禁用（bgProfileSync.enabled = false）';
  }
  if (vscode.env.appHost !== 'desktop') {
    return '跳过：非桌面版 VS Code（appHost=' + vscode.env.appHost + '）';
  }
  const emptyBehavior = options.get('emptyBehavior') === 'keep' ? 'keep' : 'clear';
  const state = sync.readState(vscode.workspace.getConfiguration('background'));
  const targets = sync.loaderTargets(vscode.env.appRoot);
  if (!targets) {
    log(context, '找不到 workbench.html，appRoot = ' + vscode.env.appRoot);
    return '找不到 workbench.html';
  }

  const mode = resolveMode(options);
  log(
    context,
    'mode=' + mode +
    ' profile hash=' + state.hash +
    ' enabled=' + state.enabled +
    ' images=' + sync.desiredImageUrls(state).length +
    ' editor=' + state.editorImages.length
  );

  if (mode === 'loader' && !state.editorImages.length) {
    return runLoaderMode(context, state, targets, emptyBehavior, force);
  }
  if (mode === 'loader' && state.editorImages.length) {
    log(context, '配了 background.editor，这一段只有 html 模式能渲染 -> 本次走 html 模式');
  }
  return runHtmlMode(context, state, targets.htmlPath, emptyBehavior, force);
}

// ---------------------------------------------------------------- loader 模式

async function runLoaderMode(context, state, targets, emptyBehavior, force) {
  const html = fs.readFileSync(targets.htmlPath, 'utf8');
  const info = sync.assessLoader(html, targets);
  log(
    context,
    'loader present=' + info.present + ' v=' + info.version + ' upToDate=' + info.upToDate +
    ' payload=' + targets.payloadPath
  );

  if (!info.upToDate) {
    const bgVersion = backgroundExtensionVersion();
    const next = sync.htmlWithLoader(html, targets, bgVersion);
    if (!write(context, targets.htmlPath, next, { expectBlock: true })) {
      return '写入背景加载器失败';
    }
    writePayloadFor(context, targets.payloadPath, state, emptyBehavior);
    log(context, '已安装背景加载器 v' + sync.LOADER_VERSION + '（之后换 profile 不再需要重载）');
    return await reloadWindow(context, state, '已安装背景加载器（仅这一次重载）');
  }

  if (sync.assess(html, state).unresolved) {
    log(context, '背景图路径无法解析（' + state.sections.fullscreen.images.length + ' 条配置），保持现状');
    return '背景图路径无法解析，保持现状';
  }

  const changed = writePayloadFor(context, targets.payloadPath, state, emptyBehavior);
  log(context, changed ? 'payload 已更新，加载器会在 ~120ms 内应用（无需重载）' : 'payload 无变化');
  return changed ? '已更新背景（无需重载）' : '已同步';
}

/** 把当前配置写成加载器要读的 JSON；返回是否真的变化 */
function writePayloadFor(context, payloadPath, state, emptyBehavior) {
  const hasImages = sync.desiredImageUrls(state).length > 0;
  if (!hasImages && emptyBehavior === 'keep') {
    log(context, '当前配置没有背景图 + emptyBehavior=keep -> 不写 payload');
    return false;
  }
  try {
    return sync.writePayload(payloadPath, state);
  } catch (error) {
    log(context, '写 payload 失败: ' + (error && error.stack ? error.stack : error));
    warnWriteError(context, error);
    return false;
  }
}

// ---------------------------------------------------------------- html 模式（兜底）

async function runHtmlMode(context, state, htmlPath, emptyBehavior, force) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const before = sync.assess(html, state);
  log(
    context,
    'html 模式: want=' + before.want + ' marker=' + (before.marker || 'none') +
    ' imagesOk=' + before.imagesOk + ' stylesOk=' + before.stylesOk +
    ' settled=' + before.settled + ' upToDate=' + before.upToDate
  );

  if (!force && before.upToDate) {
    return '已同步';
  }

  if (before.unresolved) {
    log(context, '背景图路径无法解析，保持现状');
    return '背景图路径无法解析，保持现状';
  }

  // 1) 当前 profile 没有配任何背景图
  if (!before.want) {
    if (emptyBehavior === 'keep') {
      log(context, '当前配置文件没有背景图，按 emptyBehavior=keep 保持不变');
      return '保持不变（emptyBehavior=keep）';
    }
    const next = sync.htmlCleared(html);
    if (next === html) {
      return '无需清理';
    }
    if (!write(context, htmlPath, next, { forbidBlock: true })) {
      return '清理失败（写入被拒绝）';
    }
    log(context, '当前配置文件没有背景图，已清掉注入块');
    return await reloadWindow(context, state, '已清空背景');
  }

  // 2) 注入块已经是当前配置的样子，只是标记过期 -> 只补标记，不重载
  if (before.settled) {
    const withMarker = sync.htmlWithMarker(html, state);
    if (withMarker !== html && !write(context, htmlPath, withMarker, { expectBlock: true, expectMarker: state.hash })) {
      log(context, '补标记失败，但注入块内容正确，忽略');
    }
    log(context, '注入块已符合当前配置，只补同步标记（不重载）');
    return '已同步（只补标记）';
  }

  // 3) 有背景图，且该 profile 装了 background 扩展 -> 交给它自己重写
  const bgExtension = vscode.extensions.getExtension(BG_EXT_ID);
  const recentAttempt = readRecentAttempt(context, state);
  if (bgExtension && !recentAttempt) {
    const withMarker = sync.htmlWithMarker(html, state);
    if (withMarker !== html && !write(context, htmlPath, withMarker, { expectMarker: state.hash })) {
      return '无法写入 workbench.html，已放弃委托 background 扩展';
    }
    markAttempt(context, state);
    try {
      await vscode.commands.executeCommand('extension.background.install');
      return '已交给 background 扩展重写';
    } catch (error) {
      log(context, '调用 extension.background.install 失败，改为自己生成: ' + error);
      return applyOwnBlock(context, htmlPath, state, '委托失败后自己生成');
    }
  }
  if (recentAttempt) {
    log(context, '刚刚才同步过同一个配置，改为自己生成注入块以避免重载循环');
  }

  // 4) 自己生成注入块
  return applyOwnBlock(context, htmlPath, state, '自己生成');
}

async function applyOwnBlock(context, htmlPath, state, reason) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const next = sync.htmlWithOwnBlock(html, state, { versionTag: backgroundExtensionVersion() });
  if (next === html) {
    log(context, '注入块已经是期望内容（' + reason + '）');
    return '已同步（自己生成）';
  }
  if (!write(context, htmlPath, next, { expectBlock: true, expectMarker: state.hash })) {
    return '写入失败（' + reason + '）';
  }
  log(context, '已写入自己生成的注入块（' + reason + '）');
  return await reloadWindow(context, state, '已应用背景（自己生成）');
}

// ---------------------------------------------------------------- 公共

function backgroundExtensionVersion() {
  const extension = vscode.extensions.getExtension(BG_EXT_ID);
  return (extension && extension.packageJSON && extension.packageJSON.version) || sync.FALLBACK_BG_VERSION;
}

/**
 * 校验 + 原子写入 + 备份；失败只警告一次，绝不把半截文件留在原地。
 * @returns {boolean} 是否写入成功
 */
function write(context, htmlPath, html, validation) {
  const problem = sync.validateHtml(html, validation || {});
  if (problem) {
    log(context, '拒绝写入 workbench.html：' + problem);
    return false;
  }
  const backupDir = context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, 'backup') : null;
  try {
    const backup = sync.writeHtmlAtomic(htmlPath, html, backupDir);
    log(context, '已写入 workbench.html' + (backup ? '（备份 ' + path.basename(backup) + '）' : ''));
    return true;
  } catch (error) {
    log(context, '写入 workbench.html 失败: ' + (error && error.stack ? error.stack : error));
    warnWriteError(context, error);
    return false;
  }
}

function warnWriteError(context, error) {
  if (warnedWriteError) {
    return;
  }
  warnedWriteError = true;
  vscode.window
    .showWarningMessage(
      'Background Profile Sync: 写入 VS Code 安装目录失败（' + (error && error.message) + '）。' +
        '如果 VS Code 装在受保护目录（如 Program Files），需要用管理员权限运行一次，或把安装目录改成可写。',
      '查看文档',
      '打开日志'
    )
    .then((choice) => {
      if (choice === '查看文档') {
        vscode.env.openExternal(vscode.Uri.parse(DOC_URL));
      } else if (choice === '打开日志') {
        getOutput(context).show(true);
      }
    });
}

/** html 模式用：删掉同步标记（不碰注入块），用于配置变更后触发下一次重新校验 */
async function forgetMarker(context) {
  const targets = sync.loaderTargets(vscode.env.appRoot);
  if (!targets) {
    return;
  }
  const html = fs.readFileSync(targets.htmlPath, 'utf8');
  if (sync.readMarker(html) === null) {
    return;
  }
  const next = sync.htmlWithoutMarker(html);
  if (next !== html) {
    write(context, targets.htmlPath, next, {});
    log(context, 'background.* 配置变化，已清除同步标记，下次加载重新校验');
  }
}

async function diagnose(context) {
  const channel = getOutput(context);
  const options = vscode.workspace.getConfiguration('bgProfileSync');
  const mode = resolveMode(options);
  const state = sync.readState(vscode.workspace.getConfiguration('background'));
  const targets = sync.loaderTargets(vscode.env.appRoot);
  const lines = [];
  lines.push('appRoot        : ' + vscode.env.appRoot);
  lines.push('appHost        : ' + vscode.env.appHost + '   remoteName: ' + (vscode.env.remoteName || '无'));
  lines.push('syncMode       : ' + mode + '   （loader = 零重载，html = 旧行为）');
  lines.push('background 扩展 : ' + (vscode.extensions.getExtension(BG_EXT_ID) ? '已安装' : '未安装'));
  lines.push('当前 profile   : hash=' + state.hash + ' enabled=' + state.enabled);
  if (targets) {
    lines.push('workbench.html : ' + targets.htmlPath);
    const html = fs.readFileSync(targets.htmlPath, 'utf8');
    const loader = sync.assessLoader(html, targets);
    const block = sync.extractBlock(html);
    lines.push('注入块         : ' + (block ? block.block.length + ' 字节' : '无'));
    lines.push('loader         : present=' + loader.present + ' v=' + loader.version + ' upToDate=' + loader.upToDate);
    lines.push('payload 文件   : ' + targets.payloadPath);
    try {
      const stat = fs.statSync(targets.payloadPath);
      lines.push('payload 状态   : ' + stat.size + ' 字节, mtime=' + stat.mtime.toISOString());
      const payload = JSON.parse(fs.readFileSync(targets.payloadPath, 'utf8'));
      lines.push('payload 内容   : hash=' + payload.hash + ' frames=' + (payload.frames || []).length + ' interval=' + payload.interval + ' random=' + payload.random);
    } catch (e) {
      lines.push('payload 状态   : 不存在或解析失败');
    }
    lines.push('与当前配置匹配 : ' + (sync.assess(html, state).upToDate ? '是' : '否'));
    for (const key of sync.SECTION_KEYS) {
      const section = state.sections[key];
      if (!section.images.length) {
        continue;
      }
      lines.push('  ' + key + ': ' + section.images.join(', ') + '  (opacity=' + section.opacity + ', size=' + section.size + ', position=' + section.position + ')');
    }
    if (state.editorImages.length) {
      lines.push('  editor: ' + state.editorImages.join(', ') + '  (只有 html 模式渲染)');
    }
  }
  channel.appendLine('');
  channel.appendLine('==== diagnose ' + new Date().toISOString() + ' ====');
  for (const line of lines) {
    channel.appendLine(line);
  }
  channel.show(true);
}

function readRecentAttempt(context, state) {
  const last = context.globalState.get(LAST_ATTEMPT_KEY);
  if (!last || last.hash !== state.hash) {
    return false;
  }
  return Date.now() - last.time < ATTEMPT_WINDOW_MS;
}

function markAttempt(context, state) {
  return context.globalState.update(LAST_ATTEMPT_KEY, { hash: state.hash, time: Date.now() });
}

async function reloadWindow(context, state, message) {
  if (readRecentAttempt(context, state)) {
    log(context, '短时间内重复触发，跳过重载以免死循环');
    return message + '（已跳过一次重载）';
  }
  await markAttempt(context, state);
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
  return message;
}

module.exports = { activate, deactivate };
