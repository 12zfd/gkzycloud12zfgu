'use strict';

/* ============================================================================
 * .workbuddy/qa/_auth-svc-test.js —— 起本地服务，验证 4 个 /api/auth/* 端点
 *   无 DATABASE_URL 场景：断言 503 降级结构合法（不崩、响应形状正确）。
 *   报告写 _auth-svc-test.out.txt。
 * ========================================================================== */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7860;
const BASE = 'http://127.0.0.1:' + PORT;
const lines = [];
const log = s => lines.push(s);

function req(method, pathname, body, headers) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    const r = http.request(BASE + pathname, { method, headers: h }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    r.on('error', e => resolve({ status: 0, error: String(e && e.message || e), json: null }));
    if (data) r.write(data);
    r.end();
  });
}

function assert(name, cond, detail) {
  log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  >> ' + (detail || '')));
  return cond;
}

(async () => {
  log('===== 起本地服务 (无 DATABASE_URL) =====');
  const env = Object.assign({}, process.env);
  delete env.DATABASE_URL; // 明确无 PG → 走 503 降级

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvOut = '';
  srv.stdout.on('data', d => srvOut += d);
  srv.stderr.on('data', d => srvOut += d);

  // 轮询就绪
  let ready = false;
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const r = await req('GET', '/api/health');
    if (r.status === 200 || r.status === 404) { ready = true; break; }
  }
  if (!ready) {
    log('FAIL  服务未在 10s 内就绪');
    log('---- server output ----\n' + srvOut.slice(-1500));
    try { srv.kill(); } catch (e) {}
    fs.writeFileSync(path.join(__dirname, '_auth-svc-test.out.txt'), lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
    process.exit(1);
  }
  log('PASS  服务就绪 (port ' + PORT + ')');

  let allOk = true;

  // 1) GET /api/auth/me 无 token → 结构化错误（PG 就绪时 401；PG 未就绪时 503 降级）。
  //    两者皆合法：缺失 token 的 401 分支在 routes-auth 中存在，仅在 PG 就绪时命中。
  {
    const r = await req('GET', '/api/auth/me');
    const okShape = (r.status === 401 || r.status === 503) && r.json && r.json.code === r.status &&
      typeof r.json.message === 'string';
    allOk = assert('GET /api/auth/me 无 token → 结构化错误 (401|503)', okShape,
      JSON.stringify({ status: r.status, body: r.json })) && allOk;
  }
  // 2) POST /api/auth/login → 503 降级（结构合法：code/message/Retry-After）
  {
    const r = await req('POST', '/api/auth/login', { username: 'demo', password: 'demo123' });
    const ok503 = r.status === 503 && r.json && r.json.code === 503 &&
      typeof r.json.message === 'string' && r.json.message.indexOf('E_SERVICE_WAKING') >= 0 &&
      String(r.headers['retry-after'] || '') === '30';
    allOk = assert('POST /api/auth/login 无 PG → 503 结构合法', ok503,
      JSON.stringify({ status: r.status, ra: r.headers['retry-after'], body: r.json })) && allOk;
  }
  // 3) POST /api/auth/demo → 503 降级
  {
    const r = await req('POST', '/api/auth/demo');
    const ok503 = r.status === 503 && r.json && r.json.code === 503 &&
      r.json.message.indexOf('E_SERVICE_WAKING') >= 0;
    allOk = assert('POST /api/auth/demo 无 PG → 503 结构合法', ok503, JSON.stringify(r.json)) && allOk;
  }
  // 4) POST /api/auth/logout → 503 降级
  {
    const r = await req('POST', '/api/auth/logout', { token: 'x' });
    const ok503 = r.status === 503 && r.json && r.json.code === 503;
    allOk = assert('POST /api/auth/logout 无 PG → 503 结构合法', ok503, JSON.stringify(r.json)) && allOk;
  }
  // 5) 响应绝不携带 password_hash（降级分支也不会泄漏）
  {
    const r = await req('POST', '/api/auth/login', { username: 'demo', password: 'demo123' });
    const body = JSON.stringify(r.json || '');
    allOk = assert('响应体不含 password_hash', body.indexOf('password_hash') < 0, body.slice(0, 200)) && allOk;
  }
  // 6) 其他 /api 路由未被破坏（如 /api/health 仍返回）
  {
    const r = await req('GET', '/api/health');
    allOk = assert('既有 /api 路由仍可用 (health 不崩)', r.status === 200 || r.status === 404, 'status=' + r.status) && allOk;
  }

  log('\n===== 汇总 =====');
  log((allOk ? 'ALL PASS ✅' : 'HAS FAILURES ❌'));
  try { srv.kill(); } catch (e) {}
  fs.writeFileSync(path.join(__dirname, '_auth-svc-test.out.txt'), lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  process.exit(allOk ? 0 : 1);
})();
