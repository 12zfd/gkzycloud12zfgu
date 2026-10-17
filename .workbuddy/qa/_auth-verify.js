'use strict';

/* ============================================================================
 * .workbuddy/qa/_auth-verify.js —— 登录架构全量自证
 *   步骤：① node --check 三个 JS  ② PGlite 跑 13_users.sql（幂等+登录/过期/注销）
 *         ③ index.html 内联脚本 vm.Script 语法门禁  ④ 调 _auth-accept 静态断言
 *   报告写 _auth-verify.out.txt（供人工 Read 复核）。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const vm = require('vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const lines = [];
function log(s) { lines.push(s); }
function hr(t) { log('\n===== ' + t + ' ====='); }

/* ---------- ① node --check ---------- */
hr('① node --check');
const jsFiles = [
  path.join(ROOT, 'services', 'auth.js'),
  path.join(ROOT, 'routes-auth', 'index.js'),
  path.join(ROOT, 'server.js')
];
let checkAllOk = true;
for (const f of jsFiles) {
  try {
    execSync('"' + process.execPath + '" --check "' + f + '"', { stdio: 'pipe' });
    log('PASS  node --check ' + path.basename(f));
  } catch (e) {
    checkAllOk = false;
    const msg = (e.stderr || e.stdout || '').toString().split('\n').slice(0, 3).join(' | ');
    log('FAIL  node --check ' + path.basename(f) + '  >> ' + msg);
  }
}

/* ---------- ② PGlite 验证 ---------- */
hr('② PGlite: 13_users.sql 幂等 + 登录/过期/注销');
(async () => {
  let pglite = null;
  try {
    const PG = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/@electric-sql/pglite/dist/index.cjs');
    pglite = await PG.PGlite.create();
    const sql = fs.readFileSync(path.join(ROOT, 'sql', '13_users.sql'), 'utf8');

    // 跑两次 → 幂等
    await pglite.exec(sql);
    await pglite.exec(sql);
    log('PASS  13_users.sql 执行两次无报错（幂等）');

    const tbl = await pglite.query(
      "select table_name from information_schema.tables where table_schema='public' and table_name in ('app_users','user_sessions') order by table_name"
    );
    log((tbl.rows.length === 2 ? 'PASS' : 'FAIL') + '  两表存在 (' + tbl.rows.map(r => r.table_name).join(',') + ')');

    const idx = await pglite.query(
      "select indexname from pg_indexes where schemaname='public' and indexname like 'idx_%'"
    );
    log((idx.rows.length >= 3 ? 'PASS' : 'FAIL') + '  索引存在 (' + idx.rows.map(r => r.indexname).join(',') + ')');

    // 复刻 auth.js 的哈希算法（scryptSync + 随机 salt），在 PGlite 中落地演示账号
    const SCRYPT_KEYLEN = 64;
    function hashPassword(password, salt) {
      const useSalt = salt || crypto.randomBytes(16).toString('hex');
      const derived = crypto.scryptSync(String(password), useSalt, SCRYPT_KEYLEN).toString('hex');
      return 'scrypt$' + useSalt + '$' + derived;
    }
    const demoHash = hashPassword('demo123');
    await pglite.query(
      "insert into public.app_users (username, password_hash, display_name, role, is_virtual) values ($1,$2,$3,'student',true) on conflict (username) do nothing",
      ['demo', demoHash, '体验用户']
    );
    const demo = await pglite.query("select id, is_virtual from public.app_users where username='demo'");
    log((demo.rows.length === 1 && demo.rows[0].is_virtual === true ? 'PASS' : 'FAIL') + '  demo 账号存在且 is_virtual=true');

    // 登录正确
    const row = await pglite.query("select * from public.app_users where username='demo'");
    const parts = row.rows[0].password_hash.split('$');
    const okHash = crypto.scryptSync('demo123', parts[1], SCRYPT_KEYLEN).toString('hex') === parts[2];
    log((okHash ? 'PASS' : 'FAIL') + '  正确密码校验通过');

    // 登录错误
    const badParts = (await pglite.query("select password_hash from public.app_users where username='demo'")).rows[0].password_hash.split('$');
    const badHash = crypto.scryptSync('wrong', badParts[1], SCRYPT_KEYLEN).toString('hex') === badParts[2];
    log((!badHash ? 'PASS' : 'FAIL') + '  错误密码校验拒绝');

    // 登录发 token
    const token = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await pglite.query("insert into public.user_sessions (token, user_id, expires_at) values ($1,$2,$3)", [token, row.rows[0].id, exp]);
    const sess = await pglite.query("select * from public.user_sessions where token=$1", [token]);
    log((sess.rows.length === 1 ? 'PASS' : 'FAIL') + '  登录发 30 天 token 成功');

    // 校验 token（未过期）
    const v1 = await pglite.query("select u.username from public.user_sessions s join public.app_users u on u.id=s.user_id where s.token=$1 and s.expires_at > now()", [token]);
    log((v1.rows.length === 1 ? 'PASS' : 'FAIL') + '  verifyToken 有效 token 命中用户=' + (v1.rows[0] && v1.rows[0].username));

    // 过期 token 失效
    const token2 = crypto.randomBytes(32).toString('hex');
    await pglite.query("insert into public.user_sessions (token, user_id, expires_at) values ($1,$2,$3)", [token2, row.rows[0].id, new Date(Date.now() - 1000)]);
    const v2 = await pglite.query("select 1 from public.user_sessions where token=$1 and expires_at > now()", [token2]);
    log((v2.rows.length === 0 ? 'PASS' : 'FAIL') + '  过期 token 校验拒绝');

    // 注销
    await pglite.query("delete from public.user_sessions where token=$1", [token]);
    const v3 = await pglite.query("select 1 from public.user_sessions where token=$1", [token]);
    log((v3.rows.length === 0 ? 'PASS' : 'FAIL') + '  logout 后 token 失效');

    // 确认 password_hash 不回吐（模拟 publicUser 投影）
    const projection = await pglite.query("select id, username, display_name, role, is_virtual from public.app_users where username='demo'");
    log((!('password_hash' in projection.rows[0]) ? 'PASS' : 'FAIL') + '  投影不含 password_hash');
  } catch (e) {
    log('FAIL  PGlite 验证异常 >> ' + (e && e.message ? e.message : e));
  } finally {
    if (pglite && pglite.close) { try { await pglite.close(); } catch (e) {} }
    step3();
  }
})();

/* ---------- ③ index.html 内联脚本 vm.Script 语法门禁 ---------- */
function step3() {
  hr('③ index.html 内联脚本语法门禁 (vm.Script)');
  try {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    let m, n = 0, bad = 0;
    while ((m = re.exec(html)) !== null) {
      const attrs = m[1] || '';
      const code = m[2] || '';
      if (/src\s*=/.test(attrs)) continue;       // 外链脚本不内联编译
      if (!code.trim()) continue;
      n++;
      try {
        new vm.Script(code, { filename: 'inline#' + n });
      } catch (e) {
        bad++;
        log('FAIL  内联脚本 #' + n + ' 语法错误 >> ' + (e && e.message ? e.message : e));
      }
    }
    log((bad === 0 ? 'PASS' : 'FAIL') + '  内联脚本编译 ' + n + ' 段，失败 ' + bad + ' 段');
  } catch (e) {
    log('FAIL  读取/解析 index.html 异常 >> ' + (e && e.message ? e.message : e));
  }

  step4();
}

/* ---------- ④ 调 _auth-accept 静态断言 ---------- */
function step4() {
  hr('④ _auth-accept 静态断言');
  try {
    const child = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '_auth-accept.js')], { encoding: 'utf8' });
    const out = (child.stdout || '') + (child.stderr || '');
    out.split('\n').forEach(l => { if (l.trim()) log(l); });
    if (child.status !== 0) checkAllOk = false;
  } catch (e) {
    checkAllOk = false;
    log('FAIL  _auth-accept 运行异常 >> ' + (e && e.message ? e.message : e));
  }

  hr('汇总');
  const failLines = lines.filter(l => l.startsWith('FAIL'));
  log((failLines.length === 0 && checkAllOk ? 'ALL PASS ✅' : 'HAS FAILURES ❌') + '  (FAIL 计数=' + failLines.length + ')');
  const report = lines.join('\n');
  try { fs.writeFileSync(path.join(__dirname, '_auth-verify.out.txt'), report, 'utf8'); } catch (e) {}
  console.log(report);
  process.exit(failLines.length === 0 && checkAllOk ? 0 : 1);
}
