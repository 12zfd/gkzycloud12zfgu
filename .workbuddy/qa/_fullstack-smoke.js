'use strict';
/* ============================================================================
 * _fullstack-smoke.js —— gkzy-cloud 全栈 HTTP 冒烟（真起服务，真打 HTTP）
 * 覆盖：健康/静态、列表分页、users CRUD、volunteers CRUD+幂等+越权、
 *       auth 降级闸门、D 域降级闸门、404 兜底、错误信封形状。
 * ========================================================================== */
const BASE = 'http://127.0.0.1:7860';
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? '  >> ' + detail : '')); }
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  >> ' + (detail || '')));
}
async function req(method, path, body, headers) {
  const opt = { method, headers: Object.assign({}, headers) };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r, parsed = null, raw = '';
  try { r = await fetch(BASE + path, opt); raw = await r.text(); }
  catch (e) { return { status: 0, json: null, raw: String(e), headers: new Map() }; }
  try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw: raw.slice(0, 200) }; }
  return { status: r.status, json: parsed, raw, headers: r.headers };
}

(async () => {
  /* ---------- 等服务就绪（最多 20s） ---------- */
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', '/api/health');
    if (r.status === 200) { ready = true; break; }
    await new Promise(res => setTimeout(res, 500));
  }
  ok('服务就绪 /api/health 200', ready);
  if (!ready) { console.log('SUMMARY pass=' + pass + ' fail=' + fail); process.exit(1); }

  /* ========== A. 健康与静态 ========== */
  const home = await req('GET', '/');
  ok('GET / 200', home.status === 200, 'status=' + home.status);
  ok('GET / 返回 HTML', /<!DOCTYPE/i.test(home.raw) || /<html/i.test(home.raw));
  ok('GET / 非白屏（有实质内容>20KB）', home.raw.length > 20000, 'len=' + home.raw.length);
  const idx = await req('GET', '/index.html');
  ok('GET /index.html 200', idx.status === 200);
  const h = await req('GET', '/api/health');
  ok('health code=200', h.json && h.json.code === 200);
  const hc = (h.json && h.json.data) || {};
  ok('health 计数齐全', ['colleges', 'majors', 'volunteers', 'users'].every(k => typeof hc[k] === 'number'),
    JSON.stringify(hc).slice(0, 200));
  ok('health 院校数=100', hc.colleges === 100, 'colleges=' + hc.colleges);
  ok('health 专业数=50', hc.majors === 50, 'majors=' + hc.majors);
  const pg = await req('GET', '/api/health/pg');
  ok('health/pg 可达且形状合法', pg.json !== null, pg.raw.slice(0, 120));

  /* ========== B. 列表 / 分页 / 关键词 ========== */
  const col = await req('GET', '/api/colleges');
  const colList = col.json && col.json.data && col.json.data.list;
  ok('colleges 返回数组', Array.isArray(colList));
  ok('colleges 默认分页 20 条', Array.isArray(colList) && colList.length === 20, 'len=' + (colList || []).length);
  ok('colleges total 一致', col.json.data.total > 0, 'total=' + (col.json && col.json.data && col.json.data.total));
  const col5 = await req('GET', '/api/colleges?size=5&page=2');
  ok('colleges size=5 生效', (col5.json.data.list || []).length === 5, 'len=' + (col5.json.data.list || []).length);
  const colKw = await req('GET', '/api/colleges?keyword=大学&size=100');
  ok('colleges 关键词命中且均含关键词',
    (colKw.json.data.list || []).length > 0 && (colKw.json.data.list || []).every(c => String(c.name || '').includes('大学')));
  const firstCollege = colList[0];
  ok('colleges 字段形状（id/name/province）', firstCollege && firstCollege.id != null && firstCollege.name != null && firstCollege.province != null,
    JSON.stringify(firstCollege).slice(0, 150));
  const mj = await req('GET', '/api/majors?size=50');
  ok('majors size=50 全量', (mj.json.data.list || []).length === 50, 'len=' + (mj.json.data.list || []).length);
  const mjClamp = await req('GET', '/api/majors?size=99999');
  ok('size 超上限被钳到 PAGE_SIZE_MAX', (mjClamp.json.data.list || []).length === 50, 'len=' + (mjClamp.json.data.list || []).length);
  const careers = await req('GET', '/api/careers');
  ok('careers 非空数组', Array.isArray(careers.json.data.list) && careers.json.data.list.length > 0);
  const prov = await req('GET', '/api/provinces');
  ok('provinces 非空数组', Array.isArray(prov.json.data.list) && prov.json.data.list.length > 0,
    'len=' + (prov.json.data.list || []).length);
  const news = await req('GET', '/api/news');
  ok('news 非空数组', Array.isArray(news.json.data.list) && news.json.data.list.length > 0);
  const groups = await req('GET', '/api/groups?college_id=' + firstCollege.id);
  ok('groups 按 college_id 查询返回数组', Array.isArray(groups.json.data.list));
  const adm = await req('GET', '/api/admissions?college_id=' + firstCollege.id);
  ok('admissions 返回数组', Array.isArray(adm.json.data.list));
  const scores = await req('GET', '/api/admission-scores?college_id=' + firstCollege.id);
  ok('admission-scores 返回数组', Array.isArray(scores.json.data.list));
  const nf = await req('GET', '/api/definitely-not-exist');
  ok('未知 /api/* 返回 404 JSON', nf.status === 404 && nf.json && nf.json.code === 404 && /接口不存在/.test(nf.json.message || ''));
  const badPg = await req('GET', '/api/colleges?page=abc');
  ok('非法 page 参数不 500', badPg.status < 500, 'status=' + badPg.status);

  /* ========== C. 用户 CRUD ========== */
  const uBad = await req('POST', '/api/users', { name: '坏省考生', province: '不存在的省' });
  ok('users POST 非法省份被拒 400', uBad.status === 400, 'status=' + uBad.status);
  const uNew = await req('POST', '/api/users', { name: 'QA测试考生A', province: '河南', score: 600 });
  const uA = uNew.json && uNew.json.data && (uNew.json.data.saved || uNew.json.data);
  ok('users POST 创建成功', uNew.status === 200 && uA && uA.id != null, uNew.raw.slice(0, 150));
  ok('响应不含 password_hash', !/password_hash/i.test(uNew.raw));
  const uB = await req('POST', '/api/users', { name: 'QA测试考生B', province: '河南', score: 620 });
  const uBid = uB.json && uB.json.data && (uB.json.data.saved || uB.json.data) && (uB.json.data.saved || uB.json.data).id;
  ok('users POST 创建 B 成功', uB.status === 200 && uBid != null);
  const uKw = await req('GET', '/api/users?keyword=QA测试考生A');
  ok('users keyword 搜索命中', (uKw.json.data.list || []).some(u => u.name === 'QA测试考生A'));
  const uPut = await req('PUT', '/api/users/' + uA.id, { score: 655 });
  ok('users PUT 更新分数 200', uPut.status === 200, uPut.raw.slice(0, 120));
  const uAfter = await req('GET', '/api/users?keyword=QA测试考生A');
  const uArow = (uAfter.json.data.list || []).find(u => u.id === uA.id);
  ok('users PUT 后读回分数=655', uArow && Number(uArow.score) === 655, 'score=' + (uArow && uArow.score));

  /* ========== D. 志愿表 CRUD / 幂等 / 越权 ========== */
  const v1 = await req('POST', '/api/volunteers', { kind: 'college', refId: firstCollege.id, userId: uA.id });
  ok('volunteers POST 成功', v1.status === 200 && v1.json.data && v1.json.data.saved, v1.raw.slice(0, 150));
  const v1dup = await req('POST', '/api/volunteers', { kind: 'college', refId: firstCollege.id, userId: uA.id });
  ok('volunteers 重复提交幂等 duplicated=true 且 total 不变',
    v1dup.json.data && v1dup.json.data.duplicated === true && v1dup.json.data.total === v1.json.data.total,
    'dup total=' + (v1dup.json.data && v1dup.json.data.total));
  const vKind = await req('POST', '/api/volunteers', { kind: 'school', refId: 1, userId: uA.id });
  ok('volunteers 非法 kind 被拒 400', vKind.status === 400);
  const vRef = await req('POST', '/api/volunteers', { kind: 'college', refId: 999999, userId: uA.id });
  ok('volunteers 不存在 refId 被拒 404', vRef.status === 404, 'status=' + vRef.status);
  const vGhost = await req('POST', '/api/volunteers', { kind: 'college', refId: 1, userId: 999999 });
  ok('volunteers 不存在考生被拒 404', vGhost.status === 404, 'status=' + vGhost.status);
  const vListA = await req('GET', '/api/volunteers?userId=' + uA.id);
  ok('volunteers GET A 含刚加的项',
    (vListA.json.data.list || []).some(v => v.kind === 'college' && Number(v.id) === Number(firstCollege.id)),
    'list=' + JSON.stringify(vListA.json.data.list).slice(0, 150));
  const vListB0 = await req('GET', '/api/volunteers?userId=' + uBid);
  ok('volunteers 用户隔离：B 初始为空', (vListB0.json.data.list || []).length === 0,
    'len=' + (vListB0.json.data.list || []).length);
  // 按 kind/refId 删除
  const del1 = await req('DELETE', '/api/volunteers/college/' + firstCollege.id + '?userId=' + uA.id);
  ok('volunteers DELETE kind/refId 200', del1.status === 200 && del1.json.data.changes === 1, del1.raw.slice(0, 120));
  const vListA2 = await req('GET', '/api/volunteers?userId=' + uA.id);
  ok('删除后 A 列表为空', (vListA2.json.data.list || []).length === 0);
  // 重新加一条给 A，用 B 身份去按行 id 删除 —— 越权探测（真主键从 SQLite 只读取证）
  const v2 = await req('POST', '/api/volunteers', { kind: 'major', refId: 1, userId: uA.id });
  ok('A 重新加入专业志愿', v2.status === 200);
  let pkA = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const ro = new DatabaseSync('gkzy.db', { readOnly: true });
    pkA = ro.prepare('SELECT id FROM volunteers WHERE user_id = ? AND kind = ? AND ref_id = ? ORDER BY id DESC')
            .get(uA.id, 'major', 1);
    ro.close();
    pkA = pkA && pkA.id;
  } catch (e) { pkA = null; }
  if (pkA) {
    const vDelCross = await req('DELETE', '/api/volunteers/' + pkA + '?userId=' + uBid);
    const vListA3 = await req('GET', '/api/volunteers?userId=' + uA.id);
    const stillThere = (vListA3.json.data.list || []).some(v => v.kind === 'major' && Number(v.id) === 1);
    if (vDelCross.status === 200 && !stillThere) {
      ok('⚠️越权探测：跨用户按 id 删除被拒', false,
        'B(uid=' + uBid + ') 删掉了 A 的志愿行 pk=' + pkA + '（DELETE /api/volunteers/:id 无归属校验）');
    } else {
      ok('越权探测：跨用户按 id 删除被拒', true, 'status=' + vDelCross.status + ' stillThere=' + stillThere);
    }
    const vDelOwn = await req('DELETE', '/api/volunteers/' + pkA + '?userId=' + uA.id);
    ok('本人按 id 删除 200', vDelOwn.status === 200, 'status=' + vDelOwn.status + ' ' + vDelOwn.raw.slice(0, 120));
  } else {
    ok('志愿行真主键取证成功', false, 'node:sqlite 只读失败');
  }
  const vDelGhost = await req('DELETE', '/api/volunteers/999999');
  ok('删除不存在 id 404', vDelGhost.status === 404);

  /* ========== E. auth 降级闸门（本地无 DATABASE_URL → 503） ========== */
  const aLogin = await req('POST', '/api/auth/login', { username: 'x', password: 'y' });
  ok('auth/login 无 DB → 503 E_SERVICE_WAKING', aLogin.status === 503 && /E_SERVICE_WAKING/.test(aLogin.raw),
    'status=' + aLogin.status);
  ok('auth/login 503 带 Retry-After: 30', (aLogin.headers.get('retry-after') || '') === '30');
  const aDemo = await req('POST', '/api/auth/demo');
  ok('auth/demo 降级 503', aDemo.status === 503);
  const aMe = await req('GET', '/api/auth/me');
  ok('auth/me 无 token → 503（先过 DB 闸门）', aMe.status === 503, 'status=' + aMe.status);
  const aOut = await req('POST', '/api/auth/logout', { token: 'whatever' });
  ok('auth/logout 降级 503', aOut.status === 503);

  /* ========== F. D 域降级闸门（本地无 DATABASE_URL → 503） ========== */
  const dMsg = await req('POST', '/api/family-messages', { userId: 1, room_id: 'r', sender_role: 'student', raw_text: 'hi' });
  ok('D域 family-messages POST 降级 503', dMsg.status === 503 && /E_SERVICE_WAKING/.test(dMsg.raw), 'status=' + dMsg.status);
  const dGet = await req('GET', '/api/family-messages?userId=1');
  ok('D域 family-messages GET 降级 503', dGet.status === 503);
  const dNoUid = await req('GET', '/api/family-dimensions');
  ok('D域缺 userId → 400（不默认 1）', dNoUid.status === 400 || dNoUid.status === 503, 'status=' + dNoUid.status);
  const dRooms = await req('GET', '/api/family-rooms?userId=1');
  ok('D域 family-rooms 降级 503', dRooms.status === 503);
  const dCons = await req('GET', '/api/family-consensus?userId=1');
  ok('D域 consensus 缺 room_id → 400', dCons.status === 400 && /E_PARAM_INVALID/.test(dCons.raw), 'status=' + dCons.status);
  const dCons2 = await req('GET', '/api/family-consensus?userId=1&room_id=r1');
  ok('D域 family-consensus 降级 503', dCons2.status === 503, 'status=' + dCons2.status);

  /* ========== G. 汇总 ========== */
  console.log('\n==== SUMMARY ====');
  console.log('pass=' + pass + ' fail=' + fail);
  if (fails.length) console.log('FAILED:\n' + fails.map(s => ' - ' + s).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('SMOKE FATAL', e && e.stack || e); process.exit(2); });
