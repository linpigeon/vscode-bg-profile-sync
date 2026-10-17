'use strict';

/**
 * bg-profile-sync 测试：
 *   node test/run-tests.js
 *
 * 覆盖：
 *   1. vscode-file 地址编码与 background 扩展输出一致（与当前注入块做往返校验）
 *   2. 用你机器上真实的 workbench.html + 各 profile 的真实 settings.json 跑同步判断
 *   3. 幂等性（重复应用不改变 html）
 *   4. 通过 stub 的 vscode 模块跑 extension.js 的完整流程（含收敛 / 防重载循环）
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const sync = require('../sync');

const CODE_USER = process.env.VSCODE_USER_DIR || path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User');
const EXT_REGISTRY = path.join(os.homedir(), '.vscode', 'extensions', 'extensions.json');
const BG_EXT_ID = 'shalldie.background';
const INDEX_JS = path.join(__dirname, '..', 'extension.js');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.log('  FAIL  ' + name + '\n        ' + (error && error.message));
  }
}

// ---------------------------------------------------------------- 真实素材

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 在当前 VS Code 安装目录里找 workbench.html（版本目录名会随更新变化，交给 sync.findAppRoot） */
function findRealHtml() {
  const appRoot = sync.findAppRoot();
  if (!appRoot) {
    return null;
  }
  const html = sync.findWorkbenchHtml(appRoot);
  return html ? { appRoot, html } : null;
}

function hasBackgroundExtension(registryFile) {
  try {
    return readJson(registryFile).some((item) => item.identifier && item.identifier.id === BG_EXT_ID);
  } catch (e) {
    return false;
  }
}

function loadProfiles() {
  const storage = readJson(path.join(CODE_USER, 'globalStorage', 'storage.json'));
  const raw = [{ name: 'Default', dir: null }];
  for (const item of storage.userDataProfiles || []) {
    raw.push({ name: item.name, dir: item.location });
  }
  return raw.map((profile) => {
    const base = profile.dir ? path.join(CODE_USER, 'profiles', profile.dir) : CODE_USER;
    const settingsFile = path.join(base, 'settings.json');
    const registryFile = profile.dir ? path.join(base, 'extensions.json') : EXT_REGISTRY;
    return {
      name: profile.name,
      settings: fs.existsSync(settingsFile) ? readJson(settingsFile) : {},
      hasBgExtension: hasBackgroundExtension(registryFile),
    };
  });
}

/** 模拟 vscode.WorkspaceConfiguration('background') */
function configFromSettings(settings) {
  return {
    get(key) {
      return settings['background.' + key];
    },
  };
}

function tempAppRoot(sourceHtml) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-sync-'));
  const appRoot = path.join(tmpDir, 'app');
  const htmlPath = path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html');
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, sourceHtml, 'utf8');
  return { tmpDir, appRoot, htmlPath };
}

// ---------------------------------------------------------------- stub vscode

function makeStubVscode(options) {
  const calls = [];
  const bgConfig = configFromSettings(options.settings);
  let configHandler = null;
  const stub = {
    workspace: {
      onDidChangeConfiguration(handler) {
        configHandler = handler;
        return { dispose() {} };
      },
      getConfiguration(name) {
        if (name === 'background') {
          return bgConfig;
        }
        return {
          get(key) {
            if (key === 'enabled') {
              return options.syncEnabled !== false;
            }
            if (key === 'emptyBehavior') {
              return options.emptyBehavior || 'clear';
            }
            if (key === 'syncMode') {
              return options.syncMode || 'html';
            }
            return undefined;
          },
        };
      },
    },
    env: { appRoot: options.appRoot, appHost: options.appHost || 'desktop', remoteName: options.remoteName },
    extensions: {
      getExtension(id) {
        if (options.hasBgExtension && id === BG_EXT_ID) {
          return { packageJSON: { version: options.bgVersion || '3.1.0' } };
        }
        return undefined;
      },
    },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      async executeCommand(id) {
        calls.push(id);
        if (id === 'extension.background.install') {
          if (options.installThrows) {
            throw new Error('command not found: extension.background.install');
          }
          // 模拟 background 扩展：按当前 profile 配置重写注入块
          const html = fs.readFileSync(options.htmlPath, 'utf8');
          fs.writeFileSync(options.htmlPath, sync.htmlWithOwnBlock(html, options.state, { versionTag: '3.1.0' }), 'utf8');
        }
      },
    },
    window: {
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage() {
        return Promise.resolve();
      },
      createOutputChannel() {
        const lines = [];
        return {
          lines,
          appendLine(line) {
            lines.push(line);
          },
          show() {},
          dispose() {},
        };
      },
    },
    Uri: {
      parse(value) {
        return { toString: () => value };
      },
    },
  };
  return { stub, calls, fireConfigChange: () => configHandler && configHandler({ affectsConfiguration: () => true }) };
}

function loadExtensionWithStub(stub) {
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'vscode') {
      return stub;
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(INDEX_JS)];
    return require(INDEX_JS);
  } finally {
    Module._load = originalLoad;
  }
}

function makeContext() {
  const store = {};
  return {
    subscriptions: [],
    globalStorageUri: undefined,
    globalState: {
      get(key) {
        return store[key];
      },
      async update(key, value) {
        store[key] = value;
      },
    },
  };
}

// ---------------------------------------------------------------- 主体

async function main() {
  const real = findRealHtml();
  const profiles = fs.existsSync(CODE_USER) ? loadProfiles() : [];

  console.log('\n[1] vscode-file 地址编码');
  await test('盘符路径编码与 background 扩展输出一致', () => {
    const actual = sync.toVscodeFileUrl('C:\\Users\\lin\\Pictures\\55a437d5c2908724f42ebf90c1b40ec636015449.png');
    assert.strictEqual(actual, 'vscode-file://vscode-app/c%3A/Users/lin/Pictures/55a437d5c2908724f42ebf90c1b40ec636015449.png');
  });
  await test('带空格/中文的路径会被百分号编码', () => {
    const actual = sync.toVscodeFileUrl('D:\\我的 图片\\a b.png');
    assert.ok(actual.startsWith('vscode-file://vscode-app/d%3A/'), actual);
    assert.ok(actual.includes('%20'), actual);
  });
  await test('html 里已有的 vscode-file 地址可往返编码', () => {
    if (!real) {
      return;
    }
    const block = sync.extractBlock(fs.readFileSync(real.html, 'utf8'));
    if (!block) {
      return;
    }
    const urls = Array.from(sync.blockUrls(block.block));
    assert.ok(urls.length > 0, '当前注入块里应该有图片地址');
    for (const url of urls) {
      const decoded = decodeURIComponent(url);
      const filePath = decoded.replace('vscode-file://vscode-app/', '').replace(/\//g, '\\');
      const reencoded = sync.toVscodeFileUrl(filePath.replace(/^([a-z]):/i, (m, d) => d.toUpperCase() + ':'));
      assert.strictEqual(sync.normUrl(reencoded), sync.normUrl(url), url + ' 往返后不一致');
    }
  });

  // ---------------------------------------------------------------- 写入安全 & 边界
  console.log('\n[1.5] 写入安全与边界');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-sync-unit-'));
  const imgA = path.join(tmpRoot, 'a.png');
  const imgB = path.join(tmpRoot, 'b.png');
  fs.writeFileSync(imgA, 'x');
  fs.writeFileSync(imgB, 'x');
  const emptyDir = path.join(tmpRoot, 'empty');
  fs.mkdirSync(emptyDir);

  function stateFrom(sections, enabled) {
    return sync.readState({
      get(key) {
        if (key === 'enabled') {
          return enabled !== false;
        }
        if (key === 'editor') {
          return sections.editor || {};
        }
        return sections[key];
      },
    });
  }

  const pad = '<!--' + 'p'.repeat(600) + '-->';
  const synthetic =
    '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head>' +
    '<body><script src="x.js"></script>' + pad + '</body></html>';

  await test('validateHtml：拦住缺 </html> / 重复 </html> / 太短 / 该有块却没有', () => {
    assert.strictEqual(sync.validateHtml(synthetic, {}), null, 'synthetic 本身应该合法');
    assert.ok(sync.validateHtml(synthetic.replace('</html>', ''), {}), '缺结尾应该报错');
    assert.ok(sync.validateHtml(synthetic + '</html>', {}), '重复结尾应该报错');
    assert.ok(sync.validateHtml('<html><body></body></html>', {}), '太短应该报错');
    assert.ok(sync.validateHtml(synthetic, { expectBlock: true }), '要求有块但没有应该报错');
  });

  await test('writeHtmlAtomic：内容正确、有备份、不留临时文件', () => {
    const htmlPath = path.join(tmpRoot, 'workbench.html');
    fs.writeFileSync(htmlPath, synthetic, 'utf8');
    const backupDir = path.join(tmpRoot, 'storage');
    const backup = sync.writeHtmlAtomic(htmlPath, synthetic + '\n<!--changed-->', backupDir);
    assert.strictEqual(fs.readFileSync(htmlPath, 'utf8').includes('<!--changed-->'), true);
    assert.ok(backup && fs.existsSync(backup), '应该生成备份文件');
    assert.strictEqual(fs.readFileSync(backup, 'utf8'), synthetic, '备份内容应该是旧文件');
    assert.deepStrictEqual(
      fs.readdirSync(tmpRoot).filter((name) => name.endsWith('.tmp')),
      [],
      '不应残留 .tmp'
    );
  });

  await test('writeHtmlAtomic：备份最多保留 10 份', () => {
    const htmlPath = path.join(tmpRoot, 'workbench.html');
    const backupDir = path.join(tmpRoot, 'storage');
    for (let i = 0; i < 14; i++) {
      sync.writeHtmlAtomic(htmlPath, fs.readFileSync(htmlPath, 'utf8') + '\n<!--' + i + '-->', backupDir);
    }
    const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.bak'));
    assert.ok(backups.length <= 10, '备份数量应该被裁剪，实际 ' + backups.length);
  });

  await test('生成的注入块里不会出现裸 </script>', () => {
    // size 会进 baseStyleCss、styles 会进每条图片规则，两处都要走 jsonJs 转义
    const state = stateFrom({
      fullscreen: {
        images: [imgA],
        opacity: 0.2,
        size: '</script><script>alert(1)</script>',
        styles: [{ 'background-repeat': 'no-repeat;</script><script>alert(1)</script>' }],
      },
    });
    const block = sync.buildBlock(state, '3.1.0');
    const body = block.slice(block.indexOf('<script>') + 8, block.lastIndexOf('</script>'));
    assert.ok(!body.includes('</script>'), '脚本体里不应出现裸 </script>');
    assert.ok(body.includes('\\u003c/script'), '应该被转义成 \\u003c');
  });

  await test('配了图但解析不出地址时不算「没有背景」', () => {
    const state = stateFrom({ fullscreen: { images: [emptyDir], opacity: 0.2 } });
    const assessment = sync.assess(synthetic, state);
    assert.strictEqual(assessment.configuredCount, 1);
    assert.strictEqual(assessment.desiredUrls.length, 0);
    assert.strictEqual(assessment.unresolved, true);
    assert.strictEqual(assessment.want, false, 'want=false，但调用方要看 unresolved 才决定是否清空');
  });

  await test('只配了 background.editor 时不会被清空', () => {
    const state = stateFrom({ editor: { images: [imgA], useFront: true } });
    const assessment = sync.assess(synthetic, state);
    assert.strictEqual(assessment.want, true, 'editor 段也算「要背景」');
    assert.strictEqual(assessment.configuredCount, 1);
  });

  await test('editor 段存在时无法校验图片，只认同步标记', () => {
    const state = stateFrom({ editor: { images: [imgA] } });
    const marked = sync.htmlWithMarker(synthetic, state);
    assert.strictEqual(sync.assess(marked, state).upToDate, true, '标记对就算同步');
    assert.strictEqual(sync.assess(marked, state).settled, false, '没法校验时不能走「只补标记」捷径');
  });

  await test('图片对、只是标记过期 -> settled 为真（可省一次重载）', () => {
    const state = stateFrom({ fullscreen: { images: [imgA], opacity: 0.2 } });
    const applied = sync.htmlWithOwnBlock(synthetic, state, { versionTag: '3.1.0' });
    const withoutMarker = applied.replace(/[ \t]*<!-- bg-profile-sync:[0-9a-f]+ -->[ \t]*\r?\n?/g, '');
    const assessment = sync.assess(withoutMarker, state);
    assert.strictEqual(assessment.imagesOk, true);
    assert.strictEqual(assessment.stylesOk, true);
    assert.strictEqual(assessment.settled, true);
    assert.strictEqual(assessment.upToDate, false, '标记过期，还没完全同步');
  });

  await test('opacity 变了但注入块还是旧的 -> 不能走捷径', () => {
    const before = stateFrom({ fullscreen: { images: [imgA], opacity: 0.2 } });
    const after = stateFrom({ fullscreen: { images: [imgA], opacity: 0.4 } });
    const applied = sync.htmlWithOwnBlock(synthetic, before, { versionTag: '3.1.0' });
    const assessment = sync.assess(applied, after);
    assert.strictEqual(assessment.imagesOk, true, '图片没变');
    assert.strictEqual(assessment.stylesOk, false, 'opacity 对不上');
    assert.strictEqual(assessment.settled, false, '必须重写');
  });

  await test('标记对、图片对，但注入块 CSS 格式与期望不同 -> 仍算同步（防死循环）', () => {
    const state = stateFrom({ fullscreen: { images: [imgA], opacity: 0.2 } });
    // 用 size=auto 生成注入块，再用 size=cover 的状态带标记去判定：
    // 模拟「background 扩展换了 CSS 序列化格式」的情形
    const variant = stateFrom({ fullscreen: { images: [imgA], opacity: 0.2, size: 'auto' } });
    const applied = sync.htmlWithOwnBlock(synthetic, variant, { versionTag: '3.1.0' });
    const marked = sync.htmlWithMarker(applied, state);
    const assessment = sync.assess(marked, state);
    assert.strictEqual(assessment.marker, state.hash);
    assert.strictEqual(assessment.imagesOk, true);
    assert.strictEqual(assessment.stylesOk, false, '标量样式对不上');
    assert.strictEqual(assessment.settled, false, '不走捷径');
    assert.strictEqual(assessment.upToDate, true, '标记 + 图片对就该算同步，否则会无限重载');
  });

  await test('注入块里多出别的图片地址时仍然算匹配（子集判断）', () => {
    const stateA = stateFrom({ fullscreen: { images: [imgA], opacity: 0.2 } });
    const stateAB = stateFrom({ fullscreen: { images: [imgA, imgB], opacity: 0.2 } });
    const applied = sync.htmlWithOwnBlock(synthetic, stateAB, { versionTag: '3.1.0' });
    const marked = sync.htmlWithMarker(applied, stateA);
    assert.strictEqual(sync.assess(marked, stateA).imagesOk, true, 'imgA 在块里就算匹配');
  });

  // ------------------------------------------------------------ loader 方案
  console.log('\n[1.6] 加载器方案（loader）');

  await test('loader：多图 + interval 编译成多帧', () => {
    const state = stateFrom({ fullscreen: { images: [imgA, imgB], opacity: 0.2, interval: 5 } });
    const payload = sync.buildPayload(state);
    assert.strictEqual(payload.version, sync.LOADER_VERSION);
    assert.strictEqual(payload.frames.length, 2);
    assert.strictEqual(payload.interval, 5);
    assert.strictEqual(payload.random, false);
    assert.ok(payload.frames[0].includes(sync.toVscodeFileUrl(imgA)), payload.frames[0]);
    assert.ok(payload.frames[1].includes(sync.toVscodeFileUrl(imgB)), payload.frames[1]);
    assert.ok(payload.frames[0].includes('opacity:0.2'), payload.frames[0]);
    assert.ok(payload.frames[0].includes('background-size:cover'), payload.frames[0]);
  });

  await test('loader：没有图 / enabled=false 时负载为空帧（加载器会清掉背景）', () => {
    assert.deepStrictEqual(sync.buildPayload(stateFrom({})).frames, []);
    assert.deepStrictEqual(sync.buildPayload(stateFrom({ fullscreen: { images: [imgA] } }, false)).frames, []);
  });

  await test('loader：payload 写入幂等（内容没变不写）', () => {
    const state = stateFrom({ fullscreen: { images: [imgA], opacity: 0.2 } });
    const file = path.join(tmpRoot, 'payload', 'bg-profile-sync.json');
    assert.strictEqual(sync.writePayload(file, state), true, '第一次应该写');
    assert.strictEqual(sync.writePayload(file, state), false, '第二次不应该写');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.hash, state.hash);
    assert.strictEqual(parsed.frames.length, 1);
  });

  await test('loader：块里带版本/URL 标记，assessLoader 能识别与失效判定', () => {
    const targets = { payloadUrl: 'vscode-file://vscode-app/d%3A/x/bg-profile-sync.json' };
    const html = sync.htmlWithLoader(synthetic, targets, '3.1.0');
    const info = sync.assessLoader(html, targets);
    assert.strictEqual(info.present, true);
    assert.strictEqual(info.version, sync.LOADER_VERSION);
    assert.strictEqual(info.url, targets.payloadUrl);
    assert.strictEqual(info.upToDate, true);
    assert.strictEqual(sync.assessLoader(html, { payloadUrl: 'vscode-file://vscode-app/d%3A/y.json' }).upToDate, false, '路径变了要重装');
    assert.strictEqual(sync.assessLoader(synthetic, targets).present, false);
    assert.ok(!html.includes('backgroundPreloadContainer'), 'loader 不该带旧静态注入逻辑');
    assert.ok(!html.includes('bg-profile-sync:'), 'loader 模式不再用同步标记');
    assert.ok(html.includes("'unsafe-inline'"), '内联脚本需要 unsafe-inline');
    assert.ok(html.includes('bg-profile-sync-loader:v' + sync.LOADER_VERSION), '块里应有 loader 版本标记');
  });

  await test('loader：loaderTargets 指向 workbench.html 同目录的 JSON', () => {
    const { tmpDir, appRoot, htmlPath } = tempAppRoot(synthetic);
    const targets = sync.loaderTargets(appRoot);
    assert.strictEqual(targets.htmlPath, htmlPath);
    assert.strictEqual(path.dirname(targets.payloadPath), path.dirname(htmlPath));
    assert.ok(targets.payloadUrl.startsWith('vscode-file://vscode-app/'), targets.payloadUrl);
    assert.ok(targets.payloadUrl.endsWith('bg-profile-sync.json'), targets.payloadUrl);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (!real) {
    console.log('\n[2] 跳过：找不到本机 VS Code 安装目录');
    console.log('\n[3] 跳过：找不到本机 VS Code 安装目录');
  } else {
    const originalHtml = fs.readFileSync(real.html, 'utf8');
    console.log('\n[2] 真实素材：' + real.html);
    console.log('      注入块长度 ' + (sync.extractBlock(originalHtml) ? sync.extractBlock(originalHtml).block.length : 0) + ' 字节，共 ' + profiles.length + ' 个 profile');
    let matched = 0;
    for (const profile of profiles) {
      const state = sync.readState(configFromSettings(profile.settings));
      const assessment = sync.assess(originalHtml, state);
      if (assessment.upToDate) {
        matched += 1;
      }
      console.log(
        '      ' + profile.name.padEnd(11) +
        ' bgExt=' + (profile.hasBgExtension ? 'yes' : 'no ') +
        ' want=' + (assessment.want ? 'yes' : 'no ') +
        ' 与当前注入块一致=' + (assessment.upToDate ? 'yes' : 'no ') +
        ' 图片数=' + assessment.desiredUrls.length
      );
    }
    await test('最多只有一个 profile 与当前注入块一致', () => {
      assert.ok(matched <= 1, matched + ' 个 profile 同时认为已同步');
    });

    for (const profile of profiles) {
      const state = sync.readState(configFromSettings(profile.settings));
      const assessment = sync.assess(originalHtml, state);

      if (!assessment.want) {
        await test(profile.name + '：没有背景图配置 -> 清空后判定为已同步', () => {
          const cleared = sync.htmlCleared(originalHtml);
          assert.ok(!cleared.includes('<!-- vscode-background-start'), '注入块应该被清掉');
          assert.ok(!cleared.includes('bg-profile-sync'), '同步标记应该被清掉');
          assert.ok(!/script-src\s+'unsafe-inline'/.test(cleared), 'script-src 里的 unsafe-inline 应该被还原');
          assert.strictEqual(sync.assess(cleared, state).upToDate, true);
          assert.strictEqual(sync.htmlCleared(cleared), cleared, '清空应该是幂等的');
        });
        continue;
      }

      await test(profile.name + '：写入注入块后判定为已同步，且幂等', () => {
        const applied = sync.htmlWithOwnBlock(originalHtml, state, { versionTag: '3.1.0' });
        const after = sync.assess(applied, state);
        assert.strictEqual(after.imagesOk, true, '图片地址应该匹配');
        assert.strictEqual(after.upToDate, true, '应该判定为已同步');
        assert.ok(applied.includes('background.ver.3.1.0'));
        assert.ok(applied.includes("'unsafe-inline'"));
        assert.strictEqual(applied.split('</html>').length - 1, 1, '应该只有一个 </html>');
        for (const url of assessment.desiredUrls) {
          assert.ok(applied.includes(url), '缺少图片地址 ' + url);
        }
        assert.strictEqual(sync.htmlWithOwnBlock(applied, state, { versionTag: '3.1.0' }), applied, '重复应用应完全一致');
        assert.strictEqual(sync.htmlWithMarker(applied, state), applied, '标记已存在时不应重复插入');
      });

      await test(profile.name + '：只写标记不会破坏注入块', () => {
        const marked = sync.htmlWithMarker(originalHtml, state);
        assert.ok(marked.includes('<!-- bg-profile-sync:' + state.hash + ' -->'));
        assert.ok(marked.includes('<!-- vscode-background-end -->'));
        assert.strictEqual(sync.htmlWithMarker(marked, state), marked);
        assert.ok(!sync.htmlCleared(marked).includes('bg-profile-sync'));
      });
    }

    // ------------------------------------------------------------ 端到端
    console.log('\n[3] extension.js 端到端（stub vscode）');

    for (const profile of profiles) {
      const state = sync.readState(configFromSettings(profile.settings));
      const want = sync.assess(originalHtml, state).want;
      // 有背景图的 profile 用「已清空」的 html 起手，保证一开始就是「需要同步」；
      // 没背景图的 profile 用「有注入块」的 html 起手，保证走到清理路径
      const sourceHtml = want ? sync.htmlCleared(originalHtml) : originalHtml;
      const { tmpDir, appRoot, htmlPath } = tempAppRoot(sourceHtml);
      const context = makeContext();

      const first = makeStubVscode({ settings: profile.settings, appRoot, hasBgExtension: profile.hasBgExtension, htmlPath, state });
      const extension = loadExtensionWithStub(first.stub);

      await test('端到端 ' + profile.name + '：启动一次后状态正确', async () => {
        await extension.activate(context);
        const after = sync.assess(fs.readFileSync(htmlPath, 'utf8'), state);
        assert.strictEqual(after.upToDate, true, '启动后应该已同步');
        if (!want) {
          assert.deepStrictEqual(first.calls, ['workbench.action.reloadWindow']);
        } else if (profile.hasBgExtension) {
          assert.deepStrictEqual(first.calls, ['extension.background.install'], '应该交给 background 扩展');
        } else {
          assert.deepStrictEqual(first.calls, ['workbench.action.reloadWindow'], '应该自己生成并重载');
        }
      });

      await test('端到端 ' + profile.name + '：再次启动不动作（收敛）', async () => {
        const second = makeStubVscode({ settings: profile.settings, appRoot, hasBgExtension: profile.hasBgExtension, htmlPath, state });
        const extension2 = loadExtensionWithStub(second.stub);
        await extension2.activate(context);
        assert.deepStrictEqual(second.calls, [], '第二次启动不应再做任何动作');
      });

      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    await test('端到端：注入块已正确、只是标记过期 -> 只补标记不重载', async () => {
      const profile =
        profiles.find((item) => sync.assess(originalHtml, sync.readState(configFromSettings(item.settings))).want) ||
        profiles[0];
      const state = sync.readState(configFromSettings(profile.settings));
      const applied = sync.htmlWithOwnBlock(originalHtml, state, { versionTag: '3.1.0' });
      const withoutMarker = applied.replace(/[ \t]*<!-- bg-profile-sync:[0-9a-f]+ -->[ \t]*\r?\n?/g, '');
      const { tmpDir, appRoot, htmlPath } = tempAppRoot(withoutMarker);
      const { stub, calls } = makeStubVscode({
        settings: profile.settings,
        appRoot,
        hasBgExtension: profile.hasBgExtension,
        htmlPath,
        state,
      });
      await loadExtensionWithStub(stub).activate(makeContext());
      assert.deepStrictEqual(calls, [], '已经一致就不该重载');
      assert.strictEqual(sync.readMarker(fs.readFileSync(htmlPath, 'utf8')), state.hash, '应该补上同步标记');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    await test('端到端：非桌面版（appHost=web）完全不动作', async () => {
      const profile = profiles[0];
      const state = sync.readState(configFromSettings(profile.settings));
      const { tmpDir, appRoot, htmlPath } = tempAppRoot(originalHtml);
      const { stub, calls } = makeStubVscode({
        settings: profile.settings,
        appRoot,
        hasBgExtension: profile.hasBgExtension,
        htmlPath,
        state,
        appHost: 'web',
      });
      await loadExtensionWithStub(stub).activate(makeContext());
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(fs.readFileSync(htmlPath, 'utf8'), originalHtml);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ------------------------------------------------------------ loader 端到端
    const loaderProfile =
      profiles.find((item) => sync.assess(originalHtml, sync.readState(configFromSettings(item.settings))).want) || profiles[0];
    const otherLoaderProfile = profiles.find(
      (item) =>
        item !== loaderProfile && sync.assess(originalHtml, sync.readState(configFromSettings(item.settings))).want
    );

    await test('端到端 loader：首次装加载器重载一次，之后换 profile 零重载', async () => {
      const settings = { ...loaderProfile.settings };
      const state = sync.readState(configFromSettings(settings));
      const { tmpDir, appRoot, htmlPath } = tempAppRoot(sync.htmlCleared(originalHtml));
      const context = makeContext();
      const targets = () => sync.loaderTargets(appRoot);

      const first = makeStubVscode({ settings, appRoot, hasBgExtension: loaderProfile.hasBgExtension, htmlPath, state, syncMode: 'loader' });
      await loadExtensionWithStub(first.stub).activate(context);
      assert.deepStrictEqual(first.calls, ['workbench.action.reloadWindow'], '首次安装 loader 应该只重载一次');
      assert.strictEqual(sync.assessLoader(fs.readFileSync(htmlPath, 'utf8'), targets()).upToDate, true);
      assert.ok(fs.existsSync(targets().payloadPath), 'payload 应该被写入');

      const second = makeStubVscode({ settings, appRoot, hasBgExtension: loaderProfile.hasBgExtension, htmlPath, state, syncMode: 'loader' });
      await loadExtensionWithStub(second.stub).activate(context);
      assert.deepStrictEqual(second.calls, [], '第二次启动不应重载');

      if (otherLoaderProfile) {
        const otherState = sync.readState(configFromSettings(otherLoaderProfile.settings));
        const third = makeStubVscode({
          settings: otherLoaderProfile.settings,
          appRoot,
          hasBgExtension: otherLoaderProfile.hasBgExtension,
          htmlPath,
          state: otherState,
          syncMode: 'loader',
        });
        await loadExtensionWithStub(third.stub).activate(context);
        assert.deepStrictEqual(third.calls, [], '换 profile 不应重载');
        const payload = JSON.parse(fs.readFileSync(targets().payloadPath, 'utf8'));
        assert.strictEqual(payload.hash, otherState.hash, 'payload 应该换成新 profile 的');
        assert.ok(payload.frames.length > 0);
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    await test('端到端 loader：改配置只更新 payload，不重载', async () => {
      const settings = { ...loaderProfile.settings };
      const { tmpDir, appRoot, htmlPath } = tempAppRoot(sync.htmlCleared(originalHtml));
      const context = makeContext();
      const targets = () => sync.loaderTargets(appRoot);

      const state = sync.readState(configFromSettings(settings));
      const first = makeStubVscode({ settings, appRoot, hasBgExtension: loaderProfile.hasBgExtension, htmlPath, state, syncMode: 'loader' });
      await loadExtensionWithStub(first.stub).activate(context);
      assert.deepStrictEqual(first.calls, ['workbench.action.reloadWindow']);
      const before = JSON.parse(fs.readFileSync(targets().payloadPath, 'utf8'));

      // 模拟用户改 opacity，然后配置变更事件
      const fullscreen = { ...(settings['background.fullscreen'] || {}), opacity: 0.5 };
      settings['background.fullscreen'] = fullscreen;
      first.fireConfigChange();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const after = JSON.parse(fs.readFileSync(targets().payloadPath, 'utf8'));
      assert.notStrictEqual(after.hash, before.hash, 'payload 应该更新');
      assert.ok(after.frames[0].includes('opacity:0.5'), '新 opacity 应该生效: ' + after.frames[0]);
      assert.deepStrictEqual(first.calls, ['workbench.action.reloadWindow'], '改配置不应再重载');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    await test('端到端 loader：没有背景图的 profile 写空帧，不重载', async () => {
      const noImages = profiles.find((item) => !sync.assess(originalHtml, sync.readState(configFromSettings(item.settings))).want);
      if (!noImages) {
        return;
      }
      const { tmpDir, appRoot, htmlPath } = tempAppRoot(sync.htmlCleared(originalHtml));
      const context = makeContext();
      const targets = () => sync.loaderTargets(appRoot);

      const wantState = sync.readState(configFromSettings(loaderProfile.settings));
      const first = makeStubVscode({ settings: loaderProfile.settings, appRoot, hasBgExtension: loaderProfile.hasBgExtension, htmlPath, state: wantState, syncMode: 'loader' });
      await loadExtensionWithStub(first.stub).activate(context);

      const emptyState = sync.readState(configFromSettings(noImages.settings));
      const second = makeStubVscode({ settings: noImages.settings, appRoot, hasBgExtension: noImages.hasBgExtension, htmlPath, state: emptyState, syncMode: 'loader' });
      await loadExtensionWithStub(second.stub).activate(context);
      assert.deepStrictEqual(second.calls, [], '清空背景也不该重载');
      const payload = JSON.parse(fs.readFileSync(targets().payloadPath, 'utf8'));
      assert.deepStrictEqual(payload.frames, [], '应该是空帧');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // 防重载循环：扩展重写失败时，第二次启动改为自己生成
    const loopProfile = profiles.find(
      (profile) => profile.hasBgExtension && sync.assess(originalHtml, sync.readState(configFromSettings(profile.settings))).want
    );
    if (loopProfile) {
      await test('端到端：扩展重写失败时不进入重载循环', async () => {
        const state = sync.readState(configFromSettings(loopProfile.settings));
        const { tmpDir, appRoot, htmlPath } = tempAppRoot(sync.htmlCleared(originalHtml));
        const context = makeContext();

        const first = makeStubVscode({ settings: loopProfile.settings, appRoot, hasBgExtension: true, installThrows: true, htmlPath, state });
        await loadExtensionWithStub(first.stub).activate(context);
        assert.ok(first.calls.includes('extension.background.install'), '第一次应尝试交给扩展');
        assert.strictEqual(sync.assess(fs.readFileSync(htmlPath, 'utf8'), state).upToDate, true, '失败后应自己生成注入块兜底');

        const second = makeStubVscode({ settings: loopProfile.settings, appRoot, hasBgExtension: true, installThrows: true, htmlPath, state });
        await loadExtensionWithStub(second.stub).activate(context);
        assert.deepStrictEqual(second.calls, [], '第二次启动不应再尝试，避免重载循环');
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
    }

    await test('端到端：bgProfileSync.enabled=false 时完全不动', async () => {
      const profile = profiles[0];
      const state = sync.readState(configFromSettings(profile.settings));
      const { tmpDir, appRoot, htmlPath } = tempAppRoot(originalHtml);
      const { stub, calls } = makeStubVscode({ settings: profile.settings, appRoot, hasBgExtension: profile.hasBgExtension, htmlPath, state, syncEnabled: false });
      await loadExtensionWithStub(stub).activate(makeContext());
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(fs.readFileSync(htmlPath, 'utf8'), originalHtml);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    await test('端到端：emptyBehavior=keep 时保留现有背景', async () => {
      const profile = profiles.find((p) => !sync.assess(originalHtml, sync.readState(configFromSettings(p.settings))).want);
      if (!profile) {
        return;
      }
      const state = sync.readState(configFromSettings(profile.settings));
      const { tmpDir, appRoot, htmlPath } = tempAppRoot(originalHtml);
      const { stub, calls } = makeStubVscode({ settings: profile.settings, appRoot, hasBgExtension: false, htmlPath, state, emptyBehavior: 'keep' });
      await loadExtensionWithStub(stub).activate(makeContext());
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(fs.readFileSync(htmlPath, 'utf8'), originalHtml);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  }

  console.log('\n结果: ' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const failure of failures) {
      console.log('\n--- ' + failure.name + '\n' + (failure.error && failure.error.stack));
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
