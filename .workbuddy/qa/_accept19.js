'use strict';
/* ============================================================================
 * _accept19.js —— D 域注入「静态层门禁」（零回归守门）
 * ---------------------------------------------------------------------------
 * 校验注入后的 index.html 满足 D 域静态纪律（与 domain-d/inject.js 铁律对齐，
 * 并补充 team-lead 关注的三项零回归断言）：
 *   1) CSS 块 sha 与 domain-d/app.css 逐字节一致（注入完整性 / 「CSS 块 sha 不变」）；
 *   2) 脚本块与 domain-d/app.js 逐字节一致；
 *   3) D 块 data-action 集合完整（13 个 fam-*），且与 Controller.fam* 处理函数
 *      严格一一对应（双向覆盖，无静默失效 / 死分支）；
 *   4) 委托入口 1：D 块内不得出现 addEventListener('click') / closest('[data-action]')
 *      （复用主脚本单一 click 委托，不得自己加监听）；全页 switch (action) 锚点恰为 1；
 *   5) d-domain 的 style/script 块各恰为 1。
 *
 * 用法：node .workbuddy/qa/_accept19.js [path/to/index.html]
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const HTML_PATH = process.argv[2] || path.join(REPO, 'index.html');
const CSS_PATH = path.join(REPO, 'domain-d', 'app.css');
const JS_PATH = path.join(REPO, 'domain-d', 'app.js');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg){ if (cond) { pass++; } else { fail++; fails.push(msg); } }

const html = fs.readFileSync(HTML_PATH, 'utf8');
const cssSrc = fs.readFileSync(CSS_PATH, 'utf8');
const jsSrc = fs.readFileSync(JS_PATH, 'utf8');

function sha(s){ return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/* ---------- 提取注入块 ---------- */
const styleM = html.match(/<style id="d-domain">([\s\S]*?)<\/style>/);
const scriptM = html.match(/<script id="d-domain">([\s\S]*?)<\/script>/);
ok(!!styleM, 'A1 应存在 <style id="d-domain"> 注入块');
ok(!!scriptM, 'A2 应存在 <script id="d-domain"> 注入块');
ok((html.match(/<style id="d-domain">/g) || []).length === 1, 'A3 d-style 块数量应为 1');
ok((html.match(/<script id="d-domain">/g) || []).length === 1, 'A4 d-script 块数量应为 1');

if (styleM) {
  ok(styleM[1] === cssSrc, 'B1 CSS 注入块与 domain-d/app.css 逐字节一致');
  ok(sha(styleM[1]) === sha(cssSrc), 'B2 CSS 块 sha 不变（与源文件 sha 相等）');
}
if (scriptM) {
  ok(scriptM[1] === jsSrc, 'C1 脚本注入块与 domain-d/app.js 逐字节一致');
  ok(sha(scriptM[1]) === sha(jsSrc), 'C2 脚本块 sha 不变（与源文件 sha 相等）');
}

/* ---------- data-action 集合 + 与 Controller.fam* 双向覆盖 ---------- */
const EXPECTED_ACTIONS = [
  'fam-open', 'fam-select-room', 'fam-sender-role', 'fam-send', 'fam-fold',
  'fam-edit', 'fam-save-edit', 'fam-cancel-edit', 'fam-translate', 'fam-extract',
  'fam-report', 'fam-cmp-run', 'fam-retry'
];
const actionRe = /data-action="(fam-[^"]+)"/g;
const found = new Set();
let m;
while ((m = actionRe.exec(html)) !== null) found.add(m[1]);
for (const a of EXPECTED_ACTIONS) {
  ok(found.has(a), 'D1 data-action 集合应含 ' + a);
}

/* 从全页派发表直接解析 case 'fam-x' -> Controller.famY（避免命名假设）。
 * 注意：case 语句由 inject.js 注入进【主脚本】的 switch(action)，不在 D 块内。 */
const caseRe = /case\s+'(fam-[^']+)':\s*Controller\.(fam[A-Za-z]+)/g;
const actionToFn = {};
while ((m = caseRe.exec(html)) !== null) actionToFn[m[1]] = m[2];
for (const a of EXPECTED_ACTIONS) {
  ok(!!actionToFn[a], 'E1 ' + a + ' 应在派发表中有 case 且绑定处理函数');
}

/* Controller.fam* 处理函数（仅统计 D 脚本块内绑定） */
const ctrlRe = /Controller\.(fam[A-Za-z]+)\s*=/g;
const ctrlSet = new Set();
if (scriptM) { while ((m = ctrlRe.exec(scriptM[1])) !== null) ctrlSet.add(m[1]); }
/* 每个 case 绑定的处理函数必须真实定义（无死分支） */
for (const a of EXPECTED_ACTIONS) {
  if (actionToFn[a]) ok(ctrlSet.has(actionToFn[a]), 'E2 ' + a + ' 绑定的 ' + actionToFn[a] + ' 必须已定义');
}
/* 反向：D 块里定义的 fam* 处理函数，必须被某个 case 使用（无孤儿函数） */
for (const fn of ctrlSet) {
  let used = false;
  for (const a in actionToFn) if (actionToFn[a] === fn) used = true;
  ok(used, 'E3 Controller.' + fn + ' 应被某个 case 使用（无死分支）');
}

/* ---------- 委托入口 1：D 块不得自带 click 监听 ---------- */
if (scriptM) {
  /* ★ 先剥掉注释（纪律本身以注释形式写在 app.js 头部，会误命中正则） */
  const codeOnly = scriptM[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  ok(!/addEventListener\(\s*['"]click['"]/.test(codeOnly), 'F1 D 脚本块不得自带 addEventListener(click)');
  ok(!/closest\(\s*['"]\[data-action\]/.test(codeOnly), 'F2 D 脚本块不得自带 closest([data-action])');
}
ok((html.match(/switch\s*\(action\)\s*\{/g) || []).length === 1, 'F3 全页 switch(action) 委托入口应恰为 1');

/* ---------- 收尾 ---------- */
console.log('\n=== D 域注入静态门禁 (_accept19) ===');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) { console.log('失败项：'); fails.forEach(function(f){ console.log('  - ' + f); }); process.exit(1); }
else { console.log('ALL GREEN —— 静态层零回归'); }
