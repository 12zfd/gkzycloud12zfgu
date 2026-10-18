'use strict';
/* ============================================================================
 * _banner-fix-test.js —— D 域唤醒横幅死锁修复（纯逻辑 + 手写 DOM stub）
 * ---------------------------------------------------------------------------
 * 不依赖浏览器 / 不依赖 jsdom：用极简 DOM/API/State 桩在 Node 里跑 domain-d/app.js
 * （vm.runInThisContext，使其顶层 var 落到全局，等同 <script> 标签语义）。
 *
 * 覆盖 team-lead 要求的 5 类断言：
 *   1) 超时 → waking（famApiWithTimeout 在 FAM_API_TIMEOUT 后 reject 'HTTP 503 (timeout)'）
 *   2) isFetching 死锁 15s 解锁（挂死超 15s 允许 famLoadFamily 重入）
 *   3) famRetry 3s 强制重入（挂死 >3s 立即解锁，按钮永远有响应；<3s 新鲜请求不动）
 *   4) fetched=true 后 waking 不再置 banner 可见（只走行内文案兜底）
 *   5) 成功路径收横幅（famLoadTimeline / famCmpRun 成功即 famStopWake + famShowBanner(false)）
 *
 * 超时值用环境变量 FAM_API_TIMEOUT_MS=50 加速（生产默认 10000）。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.FAM_API_TIMEOUT_MS = process.env.FAM_API_TIMEOUT_MS || '50';

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg){ if (cond) { pass++; } else { fail++; fails.push(msg); } }

/* ---------- 极简 DOM 桩 ---------- */
const elCache = {};
function makeEl(id){
  return {
    id: id, hidden: true, innerHTML: '', textContent: '', value: '', style: {},
    appendChild: function(){}, setAttribute: function(){}, getAttribute: function(){ return null; },
    addEventListener: function(){}
  };
}
function getEl(id){ if (!elCache[id]) elCache[id] = makeEl(id); return elCache[id]; }

global.window = {
  localStorage: { _m: {}, getItem: function(k){ return this._m[k] || null; }, setItem: function(k,v){ this._m[k] = String(v); } },
  addEventListener: function(){}
};
global.document = {
  hidden: false,
  getElementById: function(id){ return getEl(id); },
  createElement: function(){ return makeEl('div'); },
  addEventListener: function(){},
  // app.js 自 2026-10-17 起新增 famStanceStash()，会用 querySelectorAll 缓存立场条目；
  // 桩环境无真实 DOM，返回空数组即可（该路径仅缓存，不影响本测试的 5 类断言）。
  querySelectorAll: function(){ return []; }
};
// 避免测试里真实启动唤醒轮询定时器
global.setInterval = function(){ return 1; };
global.clearInterval = function(){};

/* ---------- API / State 桩（run 前注入，run 时闭包捕获全局 API） ---------- */
let apiImpl = function(){ return Promise.resolve({ data: { list: [] } }); };
global.API = { fetchJSON: function(){ return apiImpl.apply(null, arguments); } };
global.State = { currentUserId: 1 };
global.UI = { switchView: function(){} };
global.Controller = {};

/* ---------- 加载 app.js（等同 <script> 注入块） ---------- */
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'domain-d', 'app.js'), 'utf8');
vm.runInThisContext(SRC, { filename: 'domain-d/app.js' });

/* ---------- 工具 ---------- */
function resetFam(){
  const F = global.FAM;
  F.isFetching = false; F.fetched = false; F.fetchAt = 0;
  F.wakeTimer = null; F.wakeOn = false; F.messages = []; F.rooms = [];
  F.roomId = 'default'; F.role = 'student'; F.editId = null;
  getEl('fam-banner').hidden = true;
  getEl('fam-input').value = 'test raw text';
  getEl('fam-cmp-a').value = 'student';
  getEl('fam-cmp-b').value = 'father';
}
function awaitTimeout(p, ms){
  return Promise.race([p, new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('test-timeout')); }, ms || 2000); })]);
}
function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

const FAM = global.FAM;
const C = global.Controller;

/* ===== 1) famIsWaking 语义 ===== */
ok(global.famIsWaking(new Error('HTTP 503 (timeout)')) === true, 'famIsWaking: 超时错误应命中');
ok(global.famIsWaking(new Error('HTTP 503 service waking')) === true, 'famIsWaking: 503 文案应命中');
ok(global.famIsWaking(new Error('network down')) === false, 'famIsWaking: 普通网络错误不应命中');
ok(global.famIsWaking(null) === false, 'famIsWaking: null 不应命中');

/* ===== 2) 超时 → waking ===== */
(async function(){
  resetFam();
  apiImpl = function(){ return new Promise(function(){}); }; // 永不 resolve
  try {
    await awaitTimeout(global.famApiGet('/api/x'), 1500);
    ok(false, '超时 wrapper 应 reject');
  } catch (e) {
    ok(/503/.test(e && e.message || ''), '超时 wrapper 应 reject HTTP 503 (实际: ' + (e && e.message) + ')');
    ok(global.famIsWaking(e) === true, '超时错误应被 famIsWaking 识别为 waking');
  }

  /* ===== 3) isFetching 死锁 15s 解锁 ===== */
  resetFam();
  FAM.isFetching = true; FAM.fetchAt = Date.now();          // 刚刚开始（age < 15s）
  let called = false;
  apiImpl = function(){ called = true; return Promise.resolve({ data: { list: [] } }); };
  await awaitTimeout(FAM_isFetchingGuard());
  function FAM_isFetchingGuard(){ return global.famLoadFamily(false); }
  ok(called === false, '挂死 <15s：famLoadFamily 应空转不出请求');
  ok(FAM.fetched === false, '挂死 <15s：不应标记 fetched');

  resetFam();
  FAM.isFetching = true; FAM.fetchAt = Date.now() - 20000;   // 挂死 >15s
  apiImpl = function(){ return Promise.resolve({ data: { list: [] } }); };
  await awaitTimeout(global.famLoadFamily(false));
  ok(FAM.fetched === true, '挂死 >15s：famLoadFamily 应重入并成功（fetched=true）');
  ok(FAM.isFetching === false, '重入成功后 isFetching 应复位');
  ok(getEl('fam-banner').hidden === true, '重入成功后横幅应收起');

  /* ===== 4) famRetry 3s 强制重入 ===== */
  resetFam();
  FAM.isFetching = true; FAM.fetchAt = Date.now() - 5000;    // 挂死 >3s
  getEl('fam-banner').hidden = false;                        // 横幅当前可见
  apiImpl = function(){ return Promise.resolve({ data: { list: [] } }); };
  await awaitTimeout(C.famRetry());
  ok(FAM.fetched === true, 'famRetry(挂死>3s)：应强制重入并加载成功');
  ok(getEl('fam-banner').hidden === true, 'famRetry 后横幅应收起（按钮有响应）');

  resetFam();
  FAM.isFetching = true; FAM.fetchAt = Date.now() - 1000;    // 新鲜在途 <3s
  let called2 = false;
  apiImpl = function(){ called2 = true; return Promise.resolve({ data: { list: [] } }); };
  await awaitTimeout(C.famRetry());
  ok(called2 === false, 'famRetry(新鲜<3s)：应尊重在途请求、不重入（3s 防抖）');

  /* ===== 5) fetched=true 后 waking 不再置 banner 可见 ===== */
  resetFam();
  FAM.fetched = true;
  getEl('fam-banner').hidden = true;                         // 已收起
  apiImpl = function(){ return Promise.reject(new Error('HTTP 503 waking')); };
  await awaitTimeout(global.famLoadTimeline());
  ok(getEl('fam-banner').hidden === true, 'fetched 后 waking：大横幅不应被重新顶回（只走行内文案）');

  /* ===== 5b) 成功路径收横幅（famLoadTimeline） ===== */
  resetFam();
  getEl('fam-banner').hidden = false;                        // 模拟横幅可见中
  apiImpl = function(){ return Promise.resolve({ data: { list: [] } }); };
  await awaitTimeout(global.famLoadTimeline());
  ok(getEl('fam-banner').hidden === true, 'famLoadTimeline 成功应收横幅');
  ok(FAM.wakeTimer === null, 'famLoadTimeline 成功应 famStopWake');

  /* ===== 5c) 成功路径收横幅（famCmpRun 对比） ===== */
  resetFam();
  getEl('fam-banner').hidden = false;
  apiImpl = function(){ return Promise.resolve({ data: { counts: { only_a: 0, both: 0, only_b: 0 } } }); };
  C.famCmpRun();
  await wait(200);   // famCmpRun 不返回 promise，靠状态就绪后断言
  ok(getEl('fam-banner').hidden === true, 'famCmpRun 成功应收横幅');

  /* ===== 收尾 ===== */
  console.log('\n=== D 域唤醒横幅死锁修复自测 ===');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail) { console.log('失败项：'); fails.forEach(function(f){ console.log('  - ' + f); }); process.exit(1); }
  else { console.log('ALL GREEN'); }
})();
