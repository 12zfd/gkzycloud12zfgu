'use strict';
/* ============================================================================
 * _browser-e2e.js —— 真实 Chrome 驱动的 UI 闭环验证（对 http://127.0.0.1:7860）
 * 覆盖：登录层跳过、首页渲染、四 Tab 切换、院校列表（服务端数据）、详情弹窗、
 *       加入志愿表（真实 POST 200）、志愿页读回、移动端溢出、控制台/网络健康度。
 * ========================================================================== */
const { chromium } = require('playwright-core');
const fs = require('fs');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:7860';

// 报告同时落盘 UTF-8（git-bash 重定向会 GBK 乱码，读文件为准）
const _logs = [];
const _origLog = console.log.bind(console);
console.log = function () { const s = [...arguments].map(String).join(' '); _logs.push(s); _origLog(s); };
process.on('exit', () => { try { fs.writeFileSync(__dirname + '/_t_e2e_report.txt', _logs.join('\n'), 'utf8'); } catch (e) {} });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; fails.push(name + (detail ? ' >> ' + detail : '')); }
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  >> ' + (detail || '')));
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const badRequests = [];
  const apiCalls = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    // 预期噪声：沙箱内 CDN 不可达（ERR_CONNECTION_RESET；console 文本不含 URL）。
    // 项目规格允许 CDN 不可达→静默降级，降级正确性由「零 pageerror + 全功能断言」另行证明。
    if (/Failed to load resource.*ERR_CONNECTION_RESET/.test(t)) return;
    consoleErrors.push(t.slice(0, 160));
  });
  page.on('pageerror', e => pageErrors.push(String(e && e.message).slice(0, 160)));
  page.on('response', r => {
    const url = r.url();
    if (url.includes('/api/')) {
      apiCalls.push(r.status() + ' ' + r.request().method() + ' ' + url.replace(BASE, ''));
      if (r.status() >= 400) badRequests.push(r.status() + ' ' + r.request().method() + ' ' + url.replace(BASE, ''));
    }
  });

  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200); // 首屏拉维表

  /* 1. 基础渲染 */
  const shell = await page.evaluate(() => {
    const app = document.querySelector('#app');
    return {
      hasApp: !!app,
      appChars: app ? app.innerHTML.length : 0,
      bodyH: document.body.scrollHeight,
      hasAuth: !!document.querySelector('#auth-layer'),
      authVisible: (() => { const a = document.querySelector('#auth-layer'); return a ? a.style.display !== 'none' && !a.hidden : false; })(),
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      cssRules: [...document.styleSheets].reduce((n, s) => { try { return n + s.cssRules.length; } catch (e) { return n; } }, 0),
      title: document.title,
    };
  });
  ok('#app 存在且有内容', shell.hasApp && shell.appChars > 5000, 'chars=' + shell.appChars);
  ok('页面非白屏（body 高>600）', shell.bodyH > 600, 'h=' + shell.bodyH);
  ok('CSS 真的生效（规则数>300）', shell.cssRules > 300, 'rules=' + shell.cssRules);
  ok('auth-layer 存在', shell.hasAuth);
  ok('无横向溢出（430 壳）', shell.scrollW <= shell.innerW + 2, 'scrollW=' + shell.scrollW + ' innerW=' + shell.innerW);
  ok('document.title 非空', !!shell.title, shell.title);

  /* 2. 跳过登录 */
  const skipBtn = page.locator('[data-action="auth-skip"]').first();
  if (await skipBtn.count()) { await skipBtn.click({ force: true }); await page.waitForTimeout(400); }
  ok('auth-skip 可点（存在）', (await skipBtn.count()) > 0);

  /* 3. 首页 → 院校 Tab（服务端列表；boot 时已拉过 /api/colleges，用全程捕获断言） */
  await page.locator('[data-action="nav-to"][data-target="college"]').first().click({ force: true });
  await page.waitForTimeout(900);
  const collegeList = await page.evaluate(() => ({
    cards: document.querySelectorAll('#view-college .school-card').length,
    viewVisible: (() => { const v = document.querySelector('#view-college'); return v ? !v.hidden : false; })(),
  }));
  ok('院校 Tab 视图可见', collegeList.viewVisible);
  ok('院校列表渲染出卡片（>0）', collegeList.cards > 0, 'cards=' + collegeList.cards);
  ok('/api/colleges 真实请求 200（数据来自服务端）',
    apiCalls.some(c => c.startsWith('200 GET /api/colleges')),
    'apiCalls=' + apiCalls.slice(0, 5).join(' ; '));

  /* 4. 打开第一所院校详情（限定 #view-college，首页也有同名卡片） */
  await page.locator('#view-college .school-card').first().click({ force: true });
  await page.waitForTimeout(700);
  const sheet = await page.evaluate(() => {
    const s = document.querySelector('#sheet');
    const visible = s && s.style.display !== 'none' && !s.hidden && s.innerHTML.length > 200;
    const addBtn = document.querySelector('[data-action="add-volunteer"]');
    return { visible: !!visible, hasAdd: !!addBtn, name: (s && (s.querySelector('h2,h1,.sheet-title') || {}).textContent || '').trim().slice(0, 30) };
  });
  ok('院校详情弹窗打开', sheet.visible);
  ok('详情内有「加入志愿表」按钮', sheet.hasAdd);

  /* 5. 加入/移出志愿表（已在表内 = Toast 提示不发请求，属设计行为；否则应有非 GET 请求且 200） */
  const anyVolReq = page.waitForResponse(r => r.url().includes('/api/volunteers') && r.request().method() !== 'GET', { timeout: 8000 }).catch(() => null);
  const volBtn = page.locator('#sheet [data-action="add-volunteer"]').first();
  const btnLabel = ((await volBtn.textContent().catch(() => '')) || '').trim();
  await volBtn.click({ force: true });
  const volResp = await anyVolReq;
  const toastText = await page.evaluate(() => { const t = document.querySelector('#toast'); return t ? t.textContent : ''; });
  const inList = btnLabel.includes('已在');
  ok('志愿表交互有反馈（按钮态「' + btnLabel.slice(0, 12) + '」→ ' +
      (inList ? 'Toast「' + toastText.slice(0, 16) + '」' : 'HTTP ' + (volResp ? volResp.status() : 'none')) + '）',
    inList ? /志愿表/.test(toastText) : (!!volResp && volResp.status() === 200),
    'toast=' + toastText.slice(0, 30) + ' req=' + (volResp ? volResp.status() : 'none'));
  await page.waitForTimeout(400);

  /* 5.5 关闭详情弹窗（真实用户流：看完详情会关掉再切 Tab；不关会被遮罩挡住后续交互） */
  const closeBtn2 = page.locator('#sheet [data-action="close-sheet"]').first();
  if (await closeBtn2.count()) {
    await closeBtn2.click({ force: true });
    await page.waitForTimeout(400);
  }

  /* 6. 志愿表 Tab 读回 */
  await page.locator('[data-action="nav-to"][data-target="volunteer"]').first().click({ force: true });
  await page.waitForTimeout(900);
  const volView = await page.evaluate(() => {
    const v = document.querySelector('#view-volunteer');
    return {
      visible: v ? !v.hidden : false,
      rows: v ? v.querySelectorAll('[data-action="remove-volunteer"]').length : 0,
      emptyTip: v ? /暂无|还没有|empty/.test(v.textContent || '') : false,
      textLen: v ? (v.textContent || '').length : 0,
    };
  });
  ok('志愿表视图可见', volView.visible);
  ok('志愿表读回到刚加的项（有可删条目）', volView.rows > 0, 'rows=' + volView.rows + ' textLen=' + volView.textLen);

  /* 7. 其余视图渲染（plan 不在底部 Tab，走首页 quick-plan 入口；mine 为无入口的遗留视图，见报告） */
  for (const t of ['major', 'career', 'volunteer']) {
    await page.locator('[data-action="nav-to"][data-target="' + t + '"]').first().click({ force: true });
    await page.waitForTimeout(700);
    const vis = await page.evaluate((tt) => {
      const v = document.querySelector('#view-' + tt);
      return v ? (!v.hidden && (v.textContent || '').length > 50) : false;
    }, t);
    ok('视图 ' + t + ' 渲染非空', vis);
  }
  /* 7.5 智能填报（plan）入口在首页 */
  await page.locator('[data-action="nav-to"][data-target="home"]').first().click({ force: true });
  await page.waitForTimeout(500);
  const planBtn = page.locator('[data-action="quick-plan"]').first();
  ok('首页有「智能填报」入口', (await planBtn.count()) > 0);
  await planBtn.click({ force: true });
  await page.waitForTimeout(800);
  const planVis = await page.evaluate(() => {
    const v = document.querySelector('#view-plan');
    return v ? (!v.hidden && (v.textContent || '').length > 50) : false;
  });
  ok('智能填报视图渲染非空', planVis);

  /* 8. 二次点击详情关闭（弹窗收口） */
  await page.locator('[data-action="nav-to"][data-target="college"]').first().click({ force: true });
  await page.waitForTimeout(500);
  await page.locator('#view-college .school-card').first().click({ force: true });
  await page.waitForTimeout(500);
  const closeBtn = page.locator('#sheet [data-action="close-sheet"]').first();
  const reopenState = await page.evaluate(() => {
    const s = document.querySelector('#sheet');
    return { show: s ? s.classList.contains('show') : false, chars: s ? s.innerHTML.length : 0 };
  });
  if (await closeBtn.count()) {
    await closeBtn.click({ force: true });
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() => {
      const s = document.querySelector('#sheet');
      return !s || !s.classList.contains('show');
    });
    ok('详情弹窗可关闭', closed, 'reopen=' + JSON.stringify(reopenState));
  } else { ok('详情弹窗可关闭', false, 'close-sheet 按钮不存在'); }

  /* 9. 健康度 */
  ok('零 pageerror（未捕获 JS 异常）', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  ok('零 console.error', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
  ok('零 4xx/5xx API 请求', badRequests.length === 0, badRequests.join(' | ').slice(0, 300));
  ok('API 确实发生了交互（>0 次）', apiCalls.length > 0, 'calls=' + apiCalls.length);

  await browser.close();
  console.log('\n==== BROWSER E2E SUMMARY ====');
  console.log('pass=' + pass + ' fail=' + fail);
  console.log('API 调用清单（前 15）:\n' + apiCalls.slice(0, 15).join('\n'));
  if (fails.length) console.log('FAILED:\n' + fails.map(s => ' - ' + s).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('E2E FATAL ' + (e && e.stack || e)); process.exit(2); });
