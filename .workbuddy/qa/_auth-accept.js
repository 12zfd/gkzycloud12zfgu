'use strict';

/* ============================================================================
 * .workbuddy/qa/_auth-accept.js —— 登录 / 用户数据架构 静态断言（≥8 项）
 *   运行：node .workbuddy/qa/_auth-accept.js
 *   退出码 0 = 全部通过；非 0 = 有失败。原始输出同时写 _auth-accept.out.txt。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const results = [];
let failed = 0;

function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failed++;
  results.push((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  >> ' + (detail || '')));
  return ok;
}

/* ---------- 读取源文件 ---------- */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let authJs = '';
try { authJs = fs.readFileSync(path.join(ROOT, 'services', 'auth.js'), 'utf8'); } catch (e) {}
let routesAuth = '';
try { routesAuth = fs.readFileSync(path.join(ROOT, 'routes-auth', 'index.js'), 'utf8'); } catch (e) {}
let serverJs = '';
try { serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'); } catch (e) {}
let sql13 = '';
try { sql13 = fs.readFileSync(path.join(ROOT, 'sql', '13_users.sql'), 'utf8'); } catch (e) {}

/* 1) 前端登录覆盖层存在 */
check('FE #auth-layer present', html.indexOf('id="auth-layer"') >= 0);

/* 2) 四个 data-action 齐备 */
check('FE data-action auth-login',
  /data-action="auth-login"/.test(html));
check('FE data-action auth-demo',
  /data-action="auth-demo"/.test(html));
check('FE data-action auth-skip',
  /data-action="auth-skip"/.test(html));
check('FE data-action auth-logout',
  /data-action="auth-logout"/.test(html));

/* 3) 派发双向覆盖：dispatch case → Controller 方法 */
const methodOf = { 'auth-login': 'authLogin', 'auth-demo': 'authDemo', 'auth-skip': 'authSkip', 'auth-logout': 'authLogout' };
let caseOk = true;
for (const c in methodOf) {
  if (html.indexOf("case '" + c + "':") < 0) caseOk = false;
  if (html.indexOf('Controller.' + methodOf[c] + '(') < 0) caseOk = false;
}
check('FE dispatch case <-> Controller method coverage', caseOk);

/* 4) 全页仅一个 switch(action) {（与 _accept19 F3 同口径，不破坏门禁） */
const switchCount = (html.match(/switch\s*\(action\)\s*\{/g) || []).length;
check('FE exactly one switch(action) {', switchCount === 1, 'count=' + switchCount);

/* 5) 后端 4 个端点存在 */
check('BE POST /api/auth/login', /\.post\('\/auth\/login'/.test(routesAuth));
check('BE POST /api/auth/demo', /\.post\('\/auth\/demo'/.test(routesAuth));
check('BE GET /api/auth/me', /\.get\('\/auth\/me'/.test(routesAuth));
check('BE POST /api/auth/logout', /\.post\('\/auth\/logout'/.test(routesAuth));

/* 6) 503 降级闸门存在（L3） */
check('BE 503 degrade notReady',
  routesAuth.indexOf('E_SERVICE_WAKING') >= 0 && routesAuth.indexOf('Retry-After') >= 0);

/* 7) 响应绝不携带 password_hash：剥掉注释后，routes-auth 不得出现该字段 */
const routesAuthCode = routesAuth
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
check('BE never returns password_hash',
  routesAuthCode.indexOf('password_hash') < 0);

/* 8) auth.js 用 scryptSync + 随机 salt 哈希 */
check('SV hash scryptSync',
  /scryptSync/.test(authJs) && /randomBytes/.test(authJs));

/* 9) 演示账号 is_virtual=true，且 ensureDemoUser 存在 */
check('SV ensureDemoUser + is_virtual',
  /ensureDemoUser/.test(authJs) &&
  /DEMO_USERNAME\s*=\s*'demo'/.test(authJs) &&
  /DEMO_PASSWORD\s*=\s*'demo123'/.test(authJs) &&
  /is_virtual/.test(authJs) &&
  /is_virtual/.test(sql13));

/* 10) verifyToken 校验过期；logout 存在 */
check('SV verifyToken + logout',
  /verifyToken/.test(authJs) && /expires_at/.test(authJs) && /logout/.test(authJs));

/* 11) SQL 幂等（create table if not exists / create index if not exists） */
check('SQL idempotent',
  /create table if not exists public\.app_users/.test(sql13) &&
  /create table if not exists public\.user_sessions/.test(sql13) &&
  /create index if not exists/.test(sql13));

/* 12) SQL 带 RLS + revoke 守卫 DO-block */
check('SQL rls + revoke guard',
  /enable row level security/.test(sql13) && /do \$\$/.test(sql13) && /pg_roles/.test(sql13));

/* 13) server.js 仅新增一行挂载，且不改动其它路由 */
check('SRV routes-auth mount',
  /app\.use\('\/api',\s*require\('\.\/routes-auth'\)\);/.test(serverJs));
check('SRV mount order (after routes-d, before 404)',
  serverJs.indexOf("require('./routes-d')") < serverJs.indexOf("require('./routes-auth')") &&
  serverJs.indexOf("require('./routes-auth')") < serverJs.indexOf("接口不存在"));

/* ---------- 汇总 ---------- */
const passed = results.filter(r => r.startsWith('PASS')).length;
const summary = 'AUTH-ACCEPT: ' + passed + '/' + results.length + ' passed, failed=' + failed;
results.push('');
results.push(summary);
const out = results.join('\n');
try { fs.writeFileSync(path.join(__dirname, '_auth-accept.out.txt'), out, 'utf8'); } catch (e) {}
console.log(out);
process.exit(failed === 0 ? 0 : 1);
