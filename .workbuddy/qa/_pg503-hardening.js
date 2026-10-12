'use strict';
/* ============================================================================
 * _pg503-hardening.js —— D 域端点「PG 已配置但连接失败 → 503 而非 500」加固自测
 * ---------------------------------------------------------------------------
 * 不连真实数据库，用假 res 驱动 routes-d 导出的 ah() 包装，断言：
 *   · PG 连接类错误码（ENOTFOUND/ECONNREFUSED/ETIMEDOUT/EHOSTUNREACH/ENETUNREACH/
 *     28P01/28000/53300/XX000）→ 503（复用 notReady 形状）；
 *   · 自身 SQL bug（42P01 undefined_table）→ 仍是 500（绝不降级掩盖）；
 *   · 普通业务 DomainError（带 code+status）→ 走原 4xx/5xx 分支；
 *   · 非连接类未知错误 → 500。
 * 另断言 isPgConnectionError 分类集合正确（含对 42P01 的排除）。
 * ========================================================================== */
const path = require('path');
const rd = require(path.join(__dirname, '..', '..', 'routes-d'));

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); } }

function fakeRes() {
  return {
    _status: null, _json: null, _headers: {},
    status(s) { this._status = s; return this; },
    json(j) { this._json = j; return this; },
    set(h, v) { if (typeof h === 'string') this._headers[h] = v; else Object.assign(this._headers, h); return this; }
  };
}
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  // 1) 连接类错误 → 503
  const connCodes = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', '28P01', '28000', '53300', 'XX000'];
  for (const code of connCodes) {
    const res = fakeRes();
    const h = rd.ah(async () => { const e = new Error('boom'); e.code = code; throw e; });
    h({}, res);
    await tick();
    ok(res._status === 503, `连接错误 ${code} 应 503，实际 ${res._status}`);
    ok(res._headers['Retry-After'] === '30', `连接错误 ${code} 应带 Retry-After:30`);
  }

  // 2) 自身 SQL bug（42P01）→ 仍 500（不降级）
  {
    const res = fakeRes();
    const h = rd.ah(async () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; });
    h({}, res);
    await tick();
    ok(res._status === 500, `42P01 自身 SQL bug 应 500（不降级），实际 ${res._status}`);
  }

  // 3) 业务 DomainError（带 code+status）→ 原分支（如 422）
  {
    const res = fakeRes();
    const e = new Error('越界'); e.code = 'E_ENUM_OUT_OF_RANGE'; e.status = 422;
    const h = rd.ah(async () => { throw e; });
    h({}, res);
    await tick();
    ok(res._status === 422, `DomainError 应 422，实际 ${res._status}`);
  }

  // 4) 非连接类未知错误 → 500
  {
    const res = fakeRes();
    const h = rd.ah(async () => { throw new Error('unexpected'); });
    h({}, res);
    await tick();
    ok(res._status === 500, `未知错误应 500，实际 ${res._status}`);
  }

  // 5) isPgConnectionError 分类正确
  ok(rd.isPgConnectionError('ENOTFOUND') === true, 'ENOTFOUND 应判为连接错误');
  ok(rd.isPgConnectionError('28P01') === true, '28P01 应判为连接错误');
  ok(rd.isPgConnectionError('42P01') === false, '42P01 必须排除（自身 SQL bug）');
  ok(rd.isPgConnectionError('XX000') === true, 'XX000 应判为连接错误');
  ok(rd.isPgConnectionError('ECONNREFUSED') === true, 'ECONNREFUSED 应判为连接错误');
  ok(rd.isPgConnectionError(undefined) === false, 'undefined 应 false');
  ok(rd.isPgConnectionError('SOME_RANDOM') === false, '随机 code 应 false');

  console.log('=== PG 连接失败→503 加固自测 ===');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail) { console.log('FAILED:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  else { console.log('ALL GREEN'); }
})();
