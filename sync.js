'use strict';

/**
 * bg-profile-sync 的纯逻辑部分：不依赖 vscode 模块，可以用 node 直接跑测试。
 *
 * 背景知识：shalldie.background 通过往 VS Code 安装目录的
 * out/vs/code/electron-browser/workbench/workbench.html 里注入一段 <script>
 * 来实现背景图，而 VS Code 的「配置文件(profile)」只切换 settings.json。
 * 注入文件是全局唯一的，所以切换 profile 时不会自动跟着变。
 *
 * 本模块负责：
 *   - 读取当前窗口 background.* 配置，算出「应该是什么样」
 *   - 解析 html 里现有的注入块 / 同步标记
 *   - 判断是否已经同步；生成「清空」/「只写标记」/「自己生成整块」三种结果
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');

/** 自己生成注入块时，写在 `background.ver.` 后面的版本号（拿不到扩展版本时的兜底值） */
const FALLBACK_BG_VERSION = '3.1.0';

/** 生成顺序必须和 shalldie.background 的 PatchGenerator.create 一致 */
const SECTION_KEYS = ['sidebar', 'auxiliarybar', 'panel', 'fullscreen'];

const SECTION_SELECTORS = {
  sidebar: '.split-view-view > .part.sidebar::after',
  auxiliarybar: '.split-view-view > .part.auxiliarybar::after',
  panel: '.split-view-view > .part.panel::after',
  fullscreen: 'body::after',
};

const IMAGE_EXTS = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'mp4', 'otf', 'ttf'];

const MIX_BLEND_VAR = '--background-css-mix-blend-mode';

const START_TAG = '<!-- vscode-background-start';
const END_TAG = '<!-- vscode-background-end -->';
const MARKER_PREFIX = 'bg-profile-sync';

const BLOCK_RE = /[ \t]*<!-- vscode-background-start[\s\S]*?<!-- vscode-background-end -->[ \t]*\r?\n?/g;
const MARKER_RE = new RegExp('[ \\t]*<!-- ' + MARKER_PREFIX + ':([0-9a-f]{6,64}) -->[ \\t]*\\r?\\n?', 'g');
const FILE_URL_RE = /vscode-file:\/\/vscode-app\/[^"')]+/g;

/** VS Code「安装似乎损坏」提示的多语言文案（和 background 扩展里那份一致） */
const CORRUPT_STRINGS = [
  'installation appears to be corrupt. Please reinstall.', // en
  'je pravděpodobně poškozená. Proveďte prosím přeinstalaci.', // cs
  'Installation ist offenbar beschädigt. Führen Sie eine Neuinstallation durch.', // de
  'parece estar dañada. Vuelva a instalar.', // es
  'semble être endommagée. Effectuez une réinstallation.', // fr
  'sembra danneggiata. Reinstallare.', // it
  'インストールが壊れている可能性があります。再インストールしてください。', // ja
  '설치가 손상된 것 같습니다. 다시 설치하세요.', // ko
  'prawdopodobnie jest uszkodzona. Spróbuj zainstalować ponownie.', // pl
  'parece estar corrompida. Reinstale-o.', // pt-BR
  'ïñstællætïøñ æppëærs tø þë çørrµpt. Plëæsë rëïñstæll.', // qps-ploc
  'повреждена. Повторите установку.', // ru
  'yüklemeniz bozuk gibi görünüyor. Lütfen yeniden yükleyin.', // tr
  '安装似乎损坏。请重新安装。', // zh-hans
  '安裝似乎已損毀。請重新安裝。', // zh-hant
];

// ---------------------------------------------------------------- 基础工具

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

/** 展开 `~/xxx` 和 `${ENV}` / `$ENV`（和 background 扩展行为一致） */
function expandPath(raw) {
  let out = String(raw);
  if (out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(2));
  }
  out = out.replace(/\$\{(\w+)\}/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
  out = out.replace(/\$(\w+)/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
  return out;
}

/**
 * 绝对路径 -> background 扩展用的 `vscode-file://vscode-app/...` 地址。
 * 例：C:\Users\lin\Pictures\a.png -> vscode-file://vscode-app/c%3A/Users/lin/Pictures/a.png
 */
function toVscodeFileUrl(absPath) {
  let normalized = String(absPath).replace(/\\/g, '/');
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  const segments = normalized.split('/');
  const encoded = segments
    .map((seg, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(seg)) {
        return seg[0].toLowerCase() + '%3A';
      }
      return encodeURIComponent(seg);
    })
    .join('/');
  return 'vscode-file://vscode-app' + encoded;
}

/** 比较用：vscode-file 地址解码 + 小写（Windows 路径大小写不敏感），其它地址原样 */
function normUrl(url) {
  if (url.startsWith('vscode-file://')) {
    try {
      return decodeURIComponent(url).toLowerCase();
    } catch (e) {
      return url.toLowerCase();
    }
  }
  return url;
}

function isRemoteImage(raw) {
  return /^https?:\/\//i.test(raw) || raw.startsWith('data:');
}

function listImagesInDir(dir, depth) {
  const out = [];
  if ((depth || 0) > 8) {
    return out;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listImagesInDir(full, (depth || 0) + 1));
    } else if (IMAGE_EXTS.includes(path.extname(entry.name).slice(1).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/** 把配置里的一个 image 条目解析成一到多个可用地址 */
function resolveImageEntry(raw) {
  const value = String(raw).trim();
  if (!value) {
    return [];
  }
  if (isRemoteImage(value)) {
    return [{ raw: value, url: value, kind: 'remote' }];
  }
  let local = value;
  if (local.startsWith('file://')) {
    try {
      local = fileURLToPath(local);
    } catch (e) {
      return [];
    }
  }
  const abs = path.resolve(expandPath(local));
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch (e) {
    stat = null;
  }
  if (stat && stat.isDirectory()) {
    return listImagesInDir(abs, 0).map((file) => ({ raw: value, url: toVscodeFileUrl(file), kind: 'file' }));
  }
  return [{ raw: value, url: toVscodeFileUrl(abs), kind: 'file' }];
}

// ---------------------------------------------------------------- 读取配置

function readSection(rawSection) {
  const raw = rawSection && typeof rawSection === 'object' ? rawSection : {};
  const images = Array.isArray(raw.images) ? raw.images.filter((i) => typeof i === 'string' && i.trim()) : [];
  return {
    images,
    opacity: typeof raw.opacity === 'number' ? raw.opacity : 0.1,
    size: typeof raw.size === 'string' && raw.size ? raw.size : 'cover',
    position: typeof raw.position === 'string' && raw.position ? raw.position : 'center',
    styles: Array.isArray(raw.styles) ? raw.styles : [],
    interval: typeof raw.interval === 'number' && raw.interval > 0 ? raw.interval : 0,
    random: raw.random === true,
  };
}

/** JSON 字面量嵌入 <script> 用：把 < 转成 \u003c，避免用户数据里的 </script> 破坏 html */
function jsonJs(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 从 vscode.WorkspaceConfiguration('background') 读出「期望状态」
 * @param {{get: (key: string) => any}} cfg
 */
function readState(cfg) {
  const sections = {};
  for (const key of SECTION_KEYS) {
    sections[key] = readSection(cfg.get(key));
  }
  const editorRaw = cfg.get('editor');
  const editor = editorRaw && typeof editorRaw === 'object' ? editorRaw : {};
  const state = {
    enabled: cfg.get('enabled') !== false,
    sections,
    editorImages: Array.isArray(editor.images) ? editor.images.filter((i) => typeof i === 'string' && i.trim()) : [],
  };
  state.sections = sections;
  state.hash = sha1(stableJson(state));
  return state;
}

function sectionUrls(section) {
  const out = [];
  for (const image of section.images) {
    for (const item of resolveImageEntry(image)) {
      out.push(item.url);
    }
  }
  return out;
}

/** 所有 section 里期望出现的背景图地址（顺序同生成顺序） */
function desiredImageUrls(state) {
  const out = [];
  for (const key of SECTION_KEYS) {
    out.push(...sectionUrls(state.sections[key]));
  }
  return out;
}

/** 找到当前安装目录里的 workbench.html */
function findWorkbenchHtml(appRoot) {
  const candidates = [
    path.join(appRoot, 'out/vs/code/electron-browser/workbench/workbench.html'),
    path.join(appRoot, 'out/vs/code/electron-sandbox/workbench/workbench.html'),
    path.join(appRoot, 'out/vs/code/browser/workbench/workbench.html'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

/** VS Code 安装目录的候选（命令行脚本用；扩展里直接用 vscode.env.appRoot） */
function installRootCandidates() {
  const list = [];
  if (process.env.VSCODE_APP_ROOT) {
    list.push(process.env.VSCODE_APP_ROOT);
  }
  if (process.env.VSCODE_INSTALL_ROOT) {
    list.push(process.env.VSCODE_INSTALL_ROOT);
  }
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (localAppData) {
    list.push(path.join(localAppData, 'Programs', 'Microsoft VS Code'));
  }
  if (programFiles) {
    list.push(path.join(programFiles, 'Microsoft VS Code'));
  }
  if (programFilesX86) {
    list.push(path.join(programFilesX86, 'Microsoft VS Code'));
  }
  list.push('D:\\Microsoft VS Code');
  return list;
}

/**
 * 找到 resources/app 目录（命令行脚本用）。依次尝试：
 * VSCODE_APP_ROOT / VSCODE_INSTALL_ROOT 环境变量、常见安装位置；
 * 安装根目录下若存在带 commit hash 的子目录（VS Code 原地升级），也会进去找。
 */
function findAppRoot() {
  for (const root of installRootCandidates()) {
    const direct = [root, path.join(root, 'resources', 'app')];
    for (const candidate of direct) {
      if (findWorkbenchHtml(candidate)) {
        return candidate;
      }
    }
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(root, entry.name, 'resources', 'app');
      if (findWorkbenchHtml(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- 解析 / 判断

function extractBlock(html) {
  const re = new RegExp(BLOCK_RE.source, 'g');
  const match = re.exec(html);
  return match ? { block: match[0], text: match[0] } : null;
}

function readMarker(html) {
  const re = new RegExp(MARKER_RE.source, 'g');
  const match = re.exec(html);
  return match ? match[1] : null;
}

/** 注入块里出现过的 vscode-file 图片地址集合 */
function blockUrls(block) {
  const set = new Set();
  if (!block) {
    return set;
  }
  const re = new RegExp(FILE_URL_RE.source, 'g');
  let match;
  while ((match = re.exec(block))) {
    set.add(normUrl(match[0]));
  }
  return set;
}

/**
 * 注入块里的图片是否「包含了期望的那批」。
 * 用子集判断而不是全等：background 扩展以后多注入一个地址（比如额外的预加载）时，
 * 不会因为「多出来」而被判成不一致，进而反复重写重载。
 */
function urlsMatch(block, desiredUrls) {
  if (!block) {
    return false;
  }
  const wantFile = new Set();
  for (const url of desiredUrls) {
    if (url.startsWith('vscode-file://')) {
      wantFile.add(normUrl(url));
    } else if (!block.includes(url)) {
      return false;
    }
  }
  const gotFile = blockUrls(block);
  for (const url of wantFile) {
    if (!gotFile.has(url)) {
      return false;
    }
  }
  return true;
}

/**
 * 注入块里的「标量样式」（size / position / opacity）是否与配置一致。
 * 用来区分「图片对但 opacity 还是旧的」这种情况 —— 光看图片地址是看不出来的。
 * 依赖 background 扩展把 CSS 交给 stylis 序列化后的紧凑格式，格式一变就返回 false，
 * 只会让调用方多做一次重写，不会写错。
 */
function stylesMatch(block, state) {
  if (!block) {
    return false;
  }
  for (const key of SECTION_KEYS) {
    const section = state.sections[key];
    if (!sectionUrls(section).length) {
      continue;
    }
    if (!block.includes(baseStyleCss(section, SECTION_SELECTORS[key]))) {
      return false;
    }
  }
  return true;
}

/**
 * 判断 html 与当前 profile 的配置是否已经一致
 * @returns {{want:boolean, unresolved:boolean, marker:string|null, blockPresent:boolean,
 *            imagesOk:boolean, stylesOk:boolean, settled:boolean, upToDate:boolean,
 *            desiredUrls:string[], configuredCount:number}}
 */
function assess(html, state) {
  const block = extractBlock(html);
  const marker = readMarker(html);
  const desiredUrls = desiredImageUrls(state);
  const configuredCount =
    SECTION_KEYS.reduce((total, key) => total + state.sections[key].images.length, 0) + state.editorImages.length;

  // background.editor 的注入块我们没法校验（它是另一套 DOM 规则），只能相信标记
  const verifiable = state.editorImages.length === 0;
  const want = state.enabled && (desiredUrls.length > 0 || state.editorImages.length > 0);
  // 配了图但一个路径都解析不出来（比如只配了一个空文件夹）：保持现状，别清掉
  const unresolved = state.enabled && configuredCount > 0 && desiredUrls.length === 0 && state.editorImages.length === 0;

  const imagesOk = want ? (verifiable ? urlsMatch(block ? block.block : null, desiredUrls) : true) : !block;
  const stylesOk = want ? (verifiable ? stylesMatch(block ? block.block : null, state) : true) : !block;
  // settled: 注入块已经反映了当前配置的外观（图片 + 标量样式），只是标记可能过期。
  // 只用来「省一次重载」，不参与 upToDate 判定 —— stylesMatch 依赖注入块的 CSS 序列化
  // 格式，一旦 background 扩展换了格式化方式就会恒为 false，拿它当收敛条件会死循环。
  const settled = want ? verifiable && imagesOk && stylesOk : !block;
  // 收敛条件只用「标记 + 图片集合」：都是与格式无关的硬事实。
  const upToDate = want ? marker === state.hash && imagesOk : !block;

  return {
    want,
    unresolved,
    marker,
    blockPresent: !!block,
    imagesOk,
    stylesOk,
    settled,
    upToDate,
    desiredUrls,
    configuredCount,
  };
}

// ---------------------------------------------------------------- 写入安全

/**
 * 写入前的自检：宁可什么都不写，也不能把 workbench.html 写坏（写坏就是白屏）。
 * @returns {string|null} 出错原因，null 表示可以写
 */
function validateHtml(html, options) {
  const opts = options || {};
  if (typeof html !== 'string' || html.length < 500) {
    return '内容太短 (' + (html ? html.length : 0) + ' 字节)';
  }
  if (!/<\/html>\s*$/i.test(html)) {
    return '没有以 </html> 结尾';
  }
  if ((html.match(/<\/html>/gi) || []).length !== 1) {
    return '</html> 出现次数异常';
  }
  if (!/<script[\s>]/i.test(html)) {
    return '缺少 <script> 标签';
  }
  if (!/script-src/.test(html)) {
    return 'CSP 被破坏（找不到 script-src）';
  }
  if (opts.expectBlock && !extractBlock(html)) {
    return '期望有注入块但没有';
  }
  if (opts.forbidBlock && extractBlock(html)) {
    return '期望没有注入块但存在';
  }
  if (opts.expectMarker && readMarker(html) !== opts.expectMarker) {
    return '同步标记不匹配或缺失';
  }
  return null;
}

function timestamp() {
  const now = new Date();
  const pad = (n, width) => String(n).padStart(width || 2, '0');
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function pruneBackups(dir, keep) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('workbench.html.') && name.endsWith('.bak'))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const file of files.slice(keep)) {
      fs.rmSync(path.join(dir, file.name), { force: true });
    }
  } catch (e) {
    /* ignore */
  }
}

/**
 * 先写临时文件再 rename 覆盖，避免写一半被中断留下半个 html。
 * 顺便把旧内容备份到 backupDir（最多留 10 份）。
 * @returns {string|null} 备份文件路径
 */
function writeHtmlAtomic(htmlPath, content, backupDir) {
  const dir = path.dirname(htmlPath);
  const tmpPath = path.join(dir, '.bg-profile-sync-' + process.pid + '-' + Date.now() + '.tmp');

  let backupPath = null;
  if (backupDir) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      backupPath = path.join(backupDir, 'workbench.html.' + timestamp() + '.bak');
      fs.copyFileSync(htmlPath, backupPath);
      pruneBackups(backupDir, 10);
    } catch (e) {
      backupPath = null;
    }
  }

  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    fs.renameSync(tmpPath, htmlPath);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (e2) {
      /* ignore */
    }
    fs.writeFileSync(htmlPath, content, 'utf8');
  }
  return backupPath;
}

// ---------------------------------------------------------------- 生成 html

function insertBeforeHtmlClose(html, text) {
  const index = html.lastIndexOf('</html>');
  if (index < 0) {
    return html.replace(/\s*$/, '') + '\n' + text + '\n';
  }
  return html.slice(0, index).replace(/\s*$/, '') + '\n' + text + '\n' + html.slice(index);
}

function markerText(state) {
  return '<!-- ' + MARKER_PREFIX + ':' + state.hash + ' -->';
}

/** 去掉注入块、去掉我们自己加的标记、去掉改过的 CSP */
function htmlWithoutBlock(html) {
  return String(html)
    .replace(new RegExp(BLOCK_RE.source, 'g'), '')
    .replace(new RegExp(MARKER_RE.source, 'g'), '')
    .replace(/(script-src)\s+'unsafe-inline'/, '$1');
}

/** 只去掉我们的同步标记 */
function htmlWithoutMarker(html) {
  return String(html).replace(new RegExp(MARKER_RE.source, 'g'), '');
}

/** 只写「已同步」标记（注入块交给 background 扩展自己重写） */
function htmlWithMarker(html, state) {
  return insertBeforeHtmlClose(htmlWithoutMarker(html), markerText(state));
}

/** 清空背景（用于该 profile 没有任何背景图配置的情况） */
function htmlCleared(html) {
  return htmlWithoutBlock(html);
}

function cssDeclarations(style) {
  const excluded = ['pointer-events', 'z-index'];
  return Object.keys(style || {})
    .filter((key) => !excluded.includes(key) && style[key] !== undefined && style[key] !== null)
    .map((key) => key + ': ' + style[key] + ';')
    .join('');
}

function iife(source) {
  return '(function(){' + source + '})()';
}

function corruptNotificationCss() {
  return CORRUPT_STRINGS.map((text) => ".notification-toast-container:has([aria-label*='" + text + "']) { display: none; }").join('');
}

function themeCss() {
  return 'body { ' + MIX_BLEND_VAR + ': unset; } body:has(> .monaco-workbench.vs-dark) { ' + MIX_BLEND_VAR + ': screen; }';
}

function preloadScript(urls) {
  if (!urls.length || urls.length > 10) {
    return '';
  }
  return (
    'const images = ' + jsonJs(urls) + ';' +
    "const container = (function(){const cid='backgroundPreloadContainer';let c=document.getElementById(cid);" +
    "if(!c){c=document.createElement('div');c.id=cid;c.style.width=0;c.style.height=0;c.style.opacity=0;" +
    "c.style.overflow='hidden';document.body.appendChild(c);}return c;})();" +
    "const div=document.createElement('div');" +
    "div.style.backgroundImage=images.map(function(u){return 'url('+u+')';}).join(',');" +
    'container.appendChild(div);'
  );
}

function opacityOf(section) {
  const opacity = section.opacity;
  if (typeof opacity !== 'number' || opacity < 0 || opacity > 0.6) {
    return 0.1;
  }
  return opacity;
}

function baseStyleCss(section, selector) {
  return (
    selector + '{content:\'\';display:block;position:absolute;inset:0;z-index:1000;pointer-events:none;' +
    'background-size:' + section.size + ';background-repeat:no-repeat;background-position:' + section.position + ';' +
    'opacity:' + opacityOf(section) + ';transition:1s;mix-blend-mode:var(' + MIX_BLEND_VAR + ');}'
  );
}

function imageRules(section, selector, urls) {
  return urls.map((url, index) => {
    const style = Object.assign({}, section.styles[index] || {}, { 'background-image': 'url(' + url + ')' });
    return selector + '{' + cssDeclarations(style) + '}';
  });
}

function carouselScript(section, rules) {
  return (
    'const imageRules=' + jsonJs(rules) + ';' +
    'const random=' + (section.random ? 'true' : 'false') + ';' +
    'const interval=' + (section.interval || 0) + ';' +
    'let curIndex=-1;' +
    "const style=(function(){const ele=document.createElement('style');document.head.appendChild(ele);return ele;})();" +
    'function getNextRule(){if(random){return imageRules[Math.floor(Math.random()*imageRules.length)];}' +
    'curIndex++;curIndex=curIndex%imageRules.length;return imageRules[curIndex];}' +
    'function setNextRule(){style.textContent=getNextRule();}' +
    'if(interval>0){setInterval(setNextRule,interval*1000);}' +
    'setNextRule();'
  );
}

function styleElementScript(css) {
  return "const style=document.createElement('style');style.textContent=" + jsonJs(css) + ';document.head.appendChild(style);';
}

/**
 * 自己生成整块注入（用于该 profile 没装 background 扩展、但配置了背景图的情况）。
 * 结构与 shalldie.background 3.x 的输出保持一致，所以扩展之后接管也不会冲突。
 */
function buildBlock(state, versionTag) {
  const tag = versionTag || FALLBACK_BG_VERSION;
  const parts = [
    iife(styleElementScript(corruptNotificationCss())),
    iife(styleElementScript(themeCss())),
  ];
  for (const key of SECTION_KEYS) {
    const section = state.sections[key];
    const urls = sectionUrls(section);
    if (!urls.length) {
      continue;
    }
    const selector = SECTION_SELECTORS[key];
    parts.push(iife(preloadScript(urls)));
    parts.push(iife(styleElementScript(baseStyleCss(section, selector))));
    parts.push(iife(carouselScript(section, imageRules(section, selector, urls))));
  }
  return (
    START_TAG + ' background.ver.' + tag + ' -->\n' +
    '<script>' + parts.join(';') + '</script>\n' +
    END_TAG
  );
}

/** 清空 + 写入自己生成的注入块 + 标记 */
function htmlWithOwnBlock(html, state, options) {
  let out = htmlWithoutBlock(html);
  out = out.replace(/(script-src)(\s)/, "$1 'unsafe-inline'$2");
  const block = buildBlock(state, options && options.versionTag);
  return insertBeforeHtmlClose(out, block + '\n' + markerText(state));
}

// ---------------------------------------------------------------- 加载器方案（v2）

/**
 * 以下事实都在这台机器上实测过（VS Code 1.142.0 / Electron 40）：
 *   - workbench renderer 里已经没有 `require`（nodeIntegration 关了）→ 拿不到 fs / fs.watch；
 *   - `fetch()` 能读 `vscode-file://` 协议，但**只允许 app 目录内的文件**，外部目录一律 Failed to fetch；
 *   - `<link rel=stylesheet>` 同样只能读 app 目录内的文件（外部 err）；
 *   - `WebSocket(ws://127.0.0.1:…)` 被 CSP 放行（connect-src 里有 ws:）；
 *   - `Trusted Types` 只拦 <script>（动态建 script.src 会抛），`<style>.textContent` 可用。
 *
 * 所以加载器方案：html 里只放一个稳定的加载器脚本（含「安装似乎损坏」提示抑制 + 主题变量），
 * 它定时 fetch app 目录里的 bg-profile-sync.json（只读，不写），把里面的 CSS 帧写进 <style>。
 * 扩展只改这个 JSON —— 换 profile 不再重写 html，也就不再需要重载窗口。
 */
const LOADER_VERSION = 7;
const LOADER_MARK = 'bg-profile-sync-loader';

/** 刚加载的头 20 秒用 80ms 轮询（正好覆盖切 profile 后扩展写 payload 的那一段），之后 400ms */
const LOADER_FAST_MS = 80;
const LOADER_SLOW_MS = 400;
const LOADER_FAST_WINDOW_MS = 20000;

/**
 * 窗口标题还没渲染出来时的宽限期：这期间认不出 profile 就什么都不做，
 * 避免"先闪一张别人的图"，也避免误锁到 fallback 对应的 profile。
 */
const LOADER_GRACE_MS = 3000;

/** 写入（不备份）的原子写：先写临时文件再 rename */
function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, '.bg-profile-sync-' + process.pid + '-' + Date.now() + '.tmp');
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (e2) {
      /* ignore */
    }
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

/** loader 模式要用到的三个路径（都在 app 目录内，renderer 才 fetch 得到） */
function loaderTargets(appRoot) {
  const htmlPath = findWorkbenchHtml(appRoot);
  if (!htmlPath) {
    return null;
  }
  const payloadPath = path.join(path.dirname(htmlPath), 'bg-profile-sync.json');
  return { htmlPath, payloadPath, payloadUrl: toVscodeFileUrl(payloadPath) };
}

/**
 * 把配置编译成「帧」：每个有图的 section 一条 base 规则 + 一条图片规则。
 * 多图 + interval 时每帧一张图，加载器负责轮播（和在 html 里注入的轮播逻辑一致）。
 */
function buildFrames(state) {
  const active = SECTION_KEYS.filter((key) => sectionUrls(state.sections[key]).length > 0);
  if (!active.length) {
    return { frames: [], interval: 0, random: false };
  }
  const lists = {};
  for (const key of active) {
    lists[key] = sectionUrls(state.sections[key]);
  }
  const total = Math.max.apply(null, active.map((key) => lists[key].length));
  const interval = Math.max.apply(null, active.map((key) => state.sections[key].interval || 0));
  const random = active.some((key) => state.sections[key].random);

  const frames = [];
  for (let index = 0; index < total; index++) {
    const parts = [];
    for (const key of active) {
      const section = state.sections[key];
      const selector = SECTION_SELECTORS[key];
      const urls = lists[key];
      const at = index % urls.length;
      const style = Object.assign({}, section.styles[at] || {}, { 'background-image': 'url(' + urls[at] + ')' });
      parts.push(baseStyleCss(section, selector) + selector + '{' + cssDeclarations(style) + '}');
    }
    frames.push(parts.join('\n'));
  }
  return { frames, interval, random };
}

// ---------------------------------------------------------------- payload

/** Default 配置文件在 payload 里的名字 */
const DEFAULT_PROFILE_NAME = 'Default';

/**
 * 从窗口标题里认出配置文件名字（认不出返回 null）。
 * 依据：VS Code 默认标题模板 `${activeEditorShort} - ${rootName} - ${profileName} - ${appName}`，
 * 所以先试倒数第二段，再从后往前扫。
 * 注意：这个函数会被 String(fn) 内联进加载器脚本，**不能引用任何外部变量**。
 */
function pickProfileName(title, profiles) {
  if (!profiles) {
    return null;
  }
  var segments = String(title || '').split(' - ');
  var candidates = [];
  if (segments.length >= 2) {
    candidates.push(segments[segments.length - 2]);
  }
  for (var i = segments.length - 2; i >= 0; i--) {
    candidates.push(segments[i]);
  }
  var lookup = {};
  for (var name in profiles) {
    lookup[name.toLowerCase()] = name;
  }
  for (var c = 0; c < candidates.length; c++) {
    var key = String(candidates[c]).replace(/^\s+|\s+$/g, '').toLowerCase();
    if (key && lookup[key] !== undefined) {
      return lookup[key];
    }
  }
  return null;
}

/**
 * 决定这个窗口该用哪份 CSS。纯函数，便于单测；同样会被内联进加载器脚本。
 *
 * 规则（顺序很重要）：
 *   1. 标题里的 profile 名和已锁定的不同 -> 说明切换了配置文件（**本地切换不重载窗口**，
 *      只重启扩展宿主），跟着换
 *   2. 已经锁定且标题没变 -> 用锁定的 profile（切文件/文件夹不影响）
 *   3. 还没锁定、标题能认出 profile -> 锁定并用它
 *   4. 认不出（多半是标题还没渲染出来）且还在 grace 期内 -> **什么都不返回**
 *      （既不闪别人的图，也绝不能因为 fallback 哈希恰好等于某个 profile 的哈希就锁错人）
 *   5. 超过 grace 还认不出 -> 用 fallback（= 最后写 payload 的窗口的配置，即旧行为）
 */
function resolveProfile(input) {
  var payload = input.payload;
  var locked = input.locked || null;
  if (!payload) {
    return { locked: locked, resolved: null };
  }
  if (!payload.entries) {
    // 旧格式 payload（loader v3）：没有 profile 地图，直接用它
    return { locked: locked, resolved: { hash: payload.hash || null, name: null, entry: payload } };
  }
  var profiles = payload.profiles || {};
  if (locked && !profiles[locked]) {
    locked = null; // 这个 profile 被删了
  }
  var matched = pickProfileName(String(input.title || ''), profiles);
  // 关键：本地切换配置文件不会重载窗口，标题会从旧 profile 名变成新 profile 名。
  // 只有「新名字是已知 profile」时才认作切换，避免切文件/文件夹时乱跳。
  if (matched && matched !== locked) {
    locked = matched;
  }
  if (locked) {
    return {
      locked: locked,
      resolved: {
        hash: profiles[locked],
        name: locked,
        entry: (payload.entries || {})[profiles[locked]] || null,
      },
    };
  }
  if (input.elapsed < input.grace) {
    return { locked: null, resolved: null };
  }
  var fallback = payload.fallback || null;
  return {
    locked: null,
    resolved: { hash: fallback, name: null, entry: (payload.entries || {})[fallback] || null },
  };
}

/** <userData>/User/globalStorage/<ext-id> → <userData> */
function userDataDirFromGlobalStorage(globalStoragePath) {
  if (!globalStoragePath) {
    return null;
  }
  return path.resolve(globalStoragePath, '..', '..', '..');
}

/** 枚举所有配置文件（读磁盘，Default 在最前面） */
function listProfiles(userDataDir) {
  const out = [];
  if (!userDataDir) {
    return out;
  }
  out.push({ name: DEFAULT_PROFILE_NAME, settingsFile: path.join(userDataDir, 'User', 'settings.json') });
  let storage = null;
  try {
    // 注意：storage.json 在 <userData>/User/globalStorage/ 下（不是 <userData>/globalStorage/）
    storage = JSON.parse(fs.readFileSync(path.join(userDataDir, 'User', 'globalStorage', 'storage.json'), 'utf8'));
  } catch (e) {
    storage = null;
  }
  for (const item of (storage && storage.userDataProfiles) || []) {
    if (!item || !item.name || !item.location) {
      continue;
    }
    out.push({
      name: item.name,
      settingsFile: path.join(userDataDir, 'User', 'profiles', item.location, 'settings.json'),
    });
  }
  return out;
}

/** 从一份 settings.json 的对象读出状态（和扩展里 getConfiguration 的结果等价） */
function settingsState(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return readState({ get: (key) => source['background.' + key] });
}

/** 单个配置文件的 CSS 条目 */
function buildEntry(state) {
  return state.enabled ? buildFrames(state) : { frames: [], interval: 0, random: false };
}

/** 单配置文件 payload（枚举失败时的兜底，加载器也兼容这种旧格式） */
function buildPayload(state) {
  const entry = buildEntry(state);
  return {
    version: LOADER_VERSION,
    hash: state.hash,
    interval: entry.interval,
    random: entry.random,
    frames: entry.frames,
  };
}

/**
 * 多配置文件 payload：
 *   entries  : 哈希 → CSS 帧（相同配置只存一份）
 *   profiles : 配置文件名字 → 哈希（渲染进程用标题里的名字查这张表）
 *   fallback : 当前窗口的哈希（标题匹配不上时兜底，等于旧的"最后写者胜"）
 */
function buildMultiPayload(currentState, profileStates) {
  const entries = {};
  const profiles = {};
  const add = (name, state) => {
    if (!state) {
      return;
    }
    if (!entries[state.hash]) {
      entries[state.hash] = buildEntry(state);
    }
    if (name) {
      profiles[name] = state.hash;
    }
  };
  for (const item of profileStates || []) {
    add(item.name, item.state);
  }
  add(null, currentState);
  const current = currentState ? buildEntry(currentState) : { frames: [], interval: 0, random: false };
  return {
    version: LOADER_VERSION,
    entries: entries,
    profiles: profiles,
    fallback: currentState ? currentState.hash : null,
    // 兼容 loader v3（它只认顶层 frames）：已经打开的旧窗口读到新 payload 时不会清空背景
    hash: currentState ? currentState.hash : null,
    interval: current.interval,
    random: current.random,
    frames: current.frames,
  };
}

function serializePayload(payload) {
  return JSON.stringify(payload, null, 2) + '\n';
}

/** 写入 payload 文本；内容没变就不写。返回是否真的写了 */
function writePayloadText(payloadPath, text) {
  let current = null;
  try {
    current = fs.readFileSync(payloadPath, 'utf8');
  } catch (e) {
    current = null;
  }
  if (current === text) {
    return false;
  }
  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  writeFileAtomic(payloadPath, text);
  return true;
}

/** 单配置文件 payload 写入（兼容旧调用） */
function writePayload(payloadPath, state) {
  return writePayloadText(payloadPath, serializePayload(buildPayload(state)));
}

/** 注入的加载器脚本：fetch 同一份 JSON，按窗口标题挑出自己配置文件的 CSS 帧 */
function buildLoaderScript(payloadUrl) {
  return [
    '(function () {',
    '  var P = ' + jsonJs(payloadUrl) + ';',
    '  var FAST = ' + LOADER_FAST_MS + ', SLOW = ' + LOADER_SLOW_MS + ', WINDOW = ' + LOADER_FAST_WINDOW_MS + ';',
    '  var started = Date.now();',
    '  var applied = "";',
    '  var rotation = null;',
    '  var locked = null;',
    '  var GRACE = ' + LOADER_GRACE_MS + ';',
    '  var pickProfileName = ' + pickProfileName.toString() + ';',
    '  var resolveProfile = ' + resolveProfile.toString() + ';',
    '  function styleEl() {',
    '    var el = document.getElementById("bg-profile-sync-style");',
    '    if (!el) {',
    '      el = document.createElement("style");',
    '      el.id = "bg-profile-sync-style";',
    '      document.head.appendChild(el);',
    '    }',
    '    return el;',
    '  }',
    '  function apply(resolved) {',
    '    if (!resolved) { return; }',
    '    var entry = resolved.entry ? resolved.entry : null;',
    '    var frames = entry && entry.frames ? entry.frames : [];',
    '    var key = String(resolved && resolved.hash) + "/" + frames.length + "/" + frames.join("\\u0000");',
    '    if (key !== applied) {',
    '      applied = key;',
    '      if (rotation) { clearInterval(rotation); rotation = null; }',
    '      var el = styleEl();',
    '      var index = 0;',
    '      function show() { el.textContent = frames[index % frames.length]; }',
    '      if (!frames.length) {',
    '        el.textContent = "";',
    '      } else {',
    '        show();',
    '        if (frames.length > 1 && entry.interval > 0) {',
    '          rotation = setInterval(function () {',
    '            index = entry.random ? Math.floor(Math.random() * frames.length) : index + 1;',
    '            show();',
    '          }, entry.interval * 1000);',
    '        }',
    '      }',
    '    }',
    '  }',
    '  function tick() {',
    '    try {',
    '      fetch(P + (P.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), { cache: "no-store" })',
    '        .then(function (r) { return r.json(); })',
    '        .then(function (payload) {',
    '          var out = resolveProfile({',
    '            payload: payload,',
    '            title: String(document.title || ""),',
    '            locked: locked,',
    '            elapsed: Date.now() - started,',
    '            grace: GRACE',
    '          });',
    '          locked = out.locked;',
    '          apply(out.resolved);',
    '        })',
    '        .catch(function () {});',
    '    } catch (e) {}',
    '    setTimeout(tick, Date.now() - started < WINDOW ? FAST : SLOW);',
    '  }',
    '  tick();',
    '})();',
  ].join('\n');
}

/** 整块注入：静态的提示抑制 + 主题变量，加加载器脚本 */
function buildLoaderBlock(payloadUrl, versionTag) {
  const tag = versionTag || FALLBACK_BG_VERSION;
  const staticCss =
    [iife(styleElementScript(corruptNotificationCss())), iife(styleElementScript(themeCss()))].join(';') + ';';
  const script =
    '// ' + LOADER_MARK + ':v' + LOADER_VERSION + '\n' +
    staticCss + '\n' +
    buildLoaderScript(payloadUrl);
  return START_TAG + ' background.ver.' + tag + ' -->\n<script>' + script + '</script>\n' + END_TAG;
}

/** html 里现有的 loader 是不是当前版本、且指向当前安装目录的 payload */
function assessLoader(html, targets) {
  const block = extractBlock(html);
  const text = block ? block.block : '';
  const versionMatch = /bg-profile-sync-loader:v(\d+)/.exec(text);
  const urlMatch = /var P = "([^"]+)"/.exec(text);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  const url = urlMatch ? urlMatch[1] : null;
  return {
    present: version !== null,
    version,
    url,
    upToDate: version === LOADER_VERSION && url === targets.payloadUrl,
  };
}

/** 清空旧注入 + 装上加载器 */
function htmlWithLoader(html, targets, versionTag) {
  let out = htmlWithoutBlock(html);
  out = out.replace(/(script-src)(\s)/, "$1 'unsafe-inline'$2");
  return insertBeforeHtmlClose(out, buildLoaderBlock(targets.payloadUrl, versionTag));
}

module.exports = {
  FALLBACK_BG_VERSION,
  SECTION_KEYS,
  SECTION_SELECTORS,
  CORRUPT_STRINGS,
  sha1,
  stableJson,
  jsonJs,
  expandPath,
  toVscodeFileUrl,
  normUrl,
  isRemoteImage,
  listImagesInDir,
  resolveImageEntry,
  readSection,
  readState,
  sectionUrls,
  desiredImageUrls,
  findWorkbenchHtml,
  installRootCandidates,
  findAppRoot,
  extractBlock,
  readMarker,
  blockUrls,
  urlsMatch,
  stylesMatch,
  assess,
  validateHtml,
  writeHtmlAtomic,
  markerText,
  htmlWithoutBlock,
  htmlWithoutMarker,
  htmlWithMarker,
  htmlCleared,
  htmlWithOwnBlock,
  buildBlock,
  imageRules,
  baseStyleCss,
  opacityOf,
  insertBeforeHtmlClose,
  LOADER_VERSION,
  LOADER_MARK,
  LOADER_FAST_MS,
  LOADER_SLOW_MS,
  LOADER_FAST_WINDOW_MS,
  writeFileAtomic,
  loaderTargets,
  buildFrames,
  buildPayload,
  payloadText: serializePayload,
  serializePayload,
  writePayload,
  writePayloadText,
  DEFAULT_PROFILE_NAME,
  pickProfileName,
  resolveProfile,
  LOADER_GRACE_MS,
  userDataDirFromGlobalStorage,
  listProfiles,
  settingsState,
  buildEntry,
  buildMultiPayload,
  buildLoaderScript,
  buildLoaderBlock,
  assessLoader,
  htmlWithLoader,
};
