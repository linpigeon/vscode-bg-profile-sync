'use strict';

/**
 * 诊断脚本：列出安装目录里的注入状态（loader / html 两种模式），
 * 以及每个 VS Code 配置文件的背景配置。
 *   node status.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const sync = require('./sync');

const CODE_USER = process.env.VSCODE_USER_DIR || path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User');
const EXT_REGISTRY = path.join(os.homedir(), '.vscode', 'extensions', 'extensions.json');

/** 安装目录探测交给 sync.findAppRoot（支持 VSCODE_APP_ROOT / VSCODE_INSTALL_ROOT 与常见路径） */
function findAppRoot() {
  return sync.findAppRoot();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function hasBgExtension(registryFile) {
  const list = readJson(registryFile);
  return Array.isArray(list) && list.some((item) => item.identifier && item.identifier.id === 'shalldie.background');
}

const appRoot = findAppRoot();
if (!appRoot) {
  console.error('找不到 VS Code 安装目录（D:\\Microsoft VS Code\\<版本>\\resources\\app）');
  process.exit(1);
}

const targets = sync.loaderTargets(appRoot);
const html = fs.readFileSync(targets.htmlPath, 'utf8');
const block = sync.extractBlock(html);
const loader = sync.assessLoader(html, targets);
const marker = sync.readMarker(html);

console.log('html      : ' + targets.htmlPath);
console.log('注入块    : ' + (block ? block.block.length + ' 字节' : '无'));
console.log('模式      : ' + (loader.present ? 'loader v' + loader.version + (loader.upToDate ? '（就绪）' : '（URL/版本不匹配，待重装）') : 'html（旧注入块）'));
if (loader.present) {
  console.log('payload   : ' + targets.payloadPath);
  try {
    const payload = JSON.parse(fs.readFileSync(targets.payloadPath, 'utf8'));
    const stat = fs.statSync(targets.payloadPath);
    if (payload.entries) {
      const names = Object.keys(payload.profiles || {});
      console.log(
        '            v' + payload.version + ' 多配置文件：profiles=' + names.length +
        ' entries=' + Object.keys(payload.entries).length +
        ' fallback=' + String(payload.fallback).slice(0, 8) +
        (payload.debug ? '  [debug=true]' : '') +
        '  mtime=' + stat.mtime.toLocaleString('zh-CN')
      );
      for (const name of names) {
        const entry = payload.entries[payload.profiles[name]] || {};
        console.log(
          '            ' + (name + ':').padEnd(13) +
          ' hash=' + String(payload.profiles[name]).slice(0, 8) +
          ' frames=' + (entry.frames || []).length
        );
      }
    } else {
      console.log(
        '            hash=' + payload.hash + ' frames=' + (payload.frames || []).length +
        ' interval=' + payload.interval + ' random=' + payload.random +
        (payload.debug ? '  [debug=true 测试标记]' : '') +
        '  mtime=' + stat.mtime.toLocaleString('zh-CN')
      );
    }
  } catch (e) {
    console.log('            (payload 不存在或解析失败)');
  }
} else {
  console.log('同步标记  : ' + (marker || '无'));
}
console.log('');

const storage = readJson(path.join(CODE_USER, 'globalStorage', 'storage.json')) || {};
const raw = [{ name: 'Default', dir: null }];
for (const item of storage.userDataProfiles || []) {
  raw.push({ name: item.name, dir: item.location });
}

console.log('profile      bgExt config  一致  就位  状态           图片');
for (const profile of raw) {
  const base = profile.dir ? path.join(CODE_USER, 'profiles', profile.dir) : CODE_USER;
  const settings = readJson(path.join(base, 'settings.json')) || {};
  const registryFile = profile.dir ? path.join(base, 'extensions.json') : EXT_REGISTRY;
  const state = sync.readState({ get: (key) => settings['background.' + key] });
  const assessment = sync.assess(html, state);
  const urls = sync.desiredImageUrls(state).map((u) => path.basename(decodeURIComponent(u).replace(/\//g, '\\')));
  const verdict = assessment.unresolved
    ? '图解析不出，保持'
    : !assessment.want
      ? '不需要背景'
      : loader.present
        ? '由加载器接管'
        : assessment.upToDate
          ? '已同步'
          : assessment.settled
            ? '块对了，只缺标记'
            : '需要重写';
  console.log(
    profile.name.padEnd(12) + ' ' +
    (hasBgExtension(registryFile) ? 'yes  ' : 'no   ') + ' ' +
    (assessment.want ? 'yes   ' : 'no    ') + ' ' +
    (assessment.upToDate ? 'yes ' : 'no  ') + ' ' +
    (assessment.settled ? 'yes ' : 'no  ') + ' ' +
    verdict.padEnd(15) + ' ' +
    (urls.length ? urls.join(', ') : '-') +
    '   [hash ' + state.hash + ']'
  );
}
