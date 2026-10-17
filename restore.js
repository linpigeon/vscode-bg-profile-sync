'use strict';

/**
 * 清掉 workbench.html 里的背景注入（注入块 + 同步标记 + CSP 里的 unsafe-inline）。
 *   node restore.js
 * 会先在同目录写一个 .bak 备份。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const sync = require('./sync');

function findAppRoot() {
  return sync.findAppRoot();
}

const appRoot = findAppRoot();
if (!appRoot) {
  console.error('找不到 VS Code 安装目录');
  process.exit(1);
}

const htmlPath = sync.findWorkbenchHtml(appRoot);
const targets = sync.loaderTargets(appRoot);
const html = fs.readFileSync(htmlPath, 'utf8');
const next = sync.htmlCleared(html);

console.log('html    : ' + htmlPath);
let removedPayload = false;
if (targets && fs.existsSync(targets.payloadPath)) {
  fs.rmSync(targets.payloadPath, { force: true });
  removedPayload = true;
  console.log('payload : 已删除 ' + targets.payloadPath);
}
if (next === html) {
  console.log('结果    : 本来就没有注入块，无需处理' + (removedPayload ? '（payload 已清）' : ''));
  process.exit(0);
}

const backup = htmlPath + '.bak';
fs.writeFileSync(backup, html, 'utf8');
fs.writeFileSync(htmlPath, next, 'utf8');
console.log('备份    : ' + backup);
console.log('结果    : 已清掉注入块（' + (html.length - next.length) + ' 字节），重载窗口后生效');
