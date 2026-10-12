'use strict';

/* ============================================================================
 * routes-d/index.js —— D 域（家庭协同）Express 路由
 * ---------------------------------------------------------------------------
 * 挂载方式（server.js 末尾加 1 行，位于既有 /api 路由之后、catch-all 404 之前）：
 *   app.use('/api', require('./routes-d'));
 *
 * 复用「既有信封」的方式：本文件【本地定义】 ok()/fail()/paging()，
 * 字段名与写法逐字沿用 server.js（{ code, data:{list,total,page,pageSize} } 与
 * { code, message }），不 require server.js —— 从而避免与 server.js 的循环依赖
 * （server.js 会 require 本模块；若本模块再 require server.js 即形成环）。
 *
 * 身份：复用与 uid(req) 相同的取参位置（query.userId || body.userId），
 *       但 D 域强制判定——缺身份 → 400，绝不 default 1（新增 requireUid）。
 *
 * 降级（L3）：DATABASE_URL 未配置（isReady()=false）时，所有写/读端点一律
 *   503 + [E_SERVICE_WAKING] + Retry-After: 30；既有 A/B/C/E 域由 server.js 处理，
 *   本模块不触碰、不影响。
 * ========================================================================== */

const express = require('express');
const pg = require('../repo/pg');
const ct = require('../services/careerTranslate');
const ApiError = ct.DomainError;
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const router = express.Router();

/* ---------- 本地信封（逐字沿用 server.js，避免循环依赖） ---------- */
function ok(res, list, total, page, pageSize) {
  res.json({ code: 200, data: { list, total, page, pageSize } });
}
function fail(res, status, message) {
  res.status(status).json({ code: status, message: String(message || '服务器内部错误') });
}
function paging(query) {
  const page = Math.min(100000, Math.max(1, parseInt(query.page, 10) || 1));
  let size = parseInt(query.size, 10) || 20;
  size = Math.min(20000, Math.max(1, size));
  return { page, size, offset: (page - 1) * size };
}

/* ---------- D 域身份（强制，缺省 400，绝不 default 1） ---------- */
function requireUid(req) {
  const raw = (req.query && req.query.userId) || (req.body && req.body.userId);
  const n = parseInt(raw, 10);
  return (Number.isInteger(n) && n > 0) ? n : null;
}

/* ---------- 未就绪闸门（L3 降级） ---------- */
function notReady(res) {
  res.set('Retry-After', '30');
  fail(res, 503, '[E_SERVICE_WAKING] 服务唤醒中，约需 30 秒，请稍后重试');
  return true;
}

/* ---------- PG 连接类错误码（已配置但握手/连接失败 → 视为服务未就绪） ---------- */
/* 含：node socket 类（ENOTFOUND/ECONNREFUSED/ETIMEDOUT/EHOSTUNREACH/ENETUNREACH）
 *     + PG 协议类（28P01 鉴权失败窗口 / 28000 鉴权失败 / 53300 连接数爆 / XX000 内部）。
 * 排除 42P01（undefined_table）等自身 SQL bug —— 必须炸成 500 暴露，绝不降级成 503。 */
const PG_CONN_ERR_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  '28P01', '28000', '53300', 'XX000'
]);
function isPgConnectionError(code) {
  return typeof code === 'string' && PG_CONN_ERR_CODES.has(code);
}

/* ---------- 异步 handler 包装（捕获 rejection，避免未处理 Promise） ---------- */
function ah(handler) {
  return (req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(err => {
      // PG 已配置但连接/握手失败 → 与「未配置」同语义的 L3 503，复用 notReady（不新增响应形状）。
      if (err && err.code && isPgConnectionError(err.code)) {
        notReady(res);
        return;
      }
      if (err && err.code && err.status) {
        fail(res, err.status, '[' + err.code + '] ' + (err.message || ''));
      } else {
        fail(res, 500, '服务器内部错误');
      }
    });
  };
}

/* ---------- 方向推导（服务端防伪，不接受前端 direction） ---------- */
function deriveDirection(role) {
  return role === 'student' ? 'child_to_parent' : 'parent_to_child';
}

/* ---------- 译文状态推导（唯一判定点，前端只消费） ---------- */
function deriveTranslationState(row) {
  const st = row.translation_status;
  if (st === 'flagged') return 'flagged';
  if (st === 'failed') return 'failed';
  if (st === 'done' && row.translation_version === row.raw_version) return 'ok';
  // 从未翻译过（translation_version 为 NULL）的新消息 = pending，不是 stale
  if (st === 'pending' && row.translation_version == null) return 'pending';
  // 有过译文、但原话已改 → 旧译文失效（stale）
  if (row.translation_version !== row.raw_version) return 'stale';
  return 'pending';
}
function publicTranslationText(row, state) {
  // stale/failed/flagged 一律不返回译文（降级绝不原话直发）
  if (state === 'stale' || state === 'failed' || state === 'flagged') return null;
  return row.translation_text;
}
function shapeMessage(row) {
  const state = deriveTranslationState(row);
  return {
    id: row.id, user_id: row.user_id, room_id: row.room_id,
    sender_role: row.sender_role, direction: row.direction,
    raw_text: row.raw_text, raw_version: row.raw_version, raw_edited_at: row.raw_edited_at,
    translation_text: publicTranslationText(row, state),
    translation_version: row.translation_version, translation_status: row.translation_status,
    translation_engine: row.translation_engine, translated_by: row.translated_by,
    is_flagged: row.is_flagged, flag_reason: row.flag_reason, folded: row.folded,
    created_at: row.created_at, updated_at: row.updated_at,
    translation_state: state
  };
}

/* ---------- 信号读取与整型 ---------- */
async function loadSignals(messageId, rawVersion, includeStale) {
  let sql = 'SELECT * FROM public.message_career_signal WHERE message_id = $1';
  const params = [messageId];
  if (!includeStale) { sql += ' AND raw_version = $2'; params.push(rawVersion); }
  sql += ' ORDER BY id ASC';
  return pg.query(sql, params);
}
function shapeSignal(sig, msgRawVersion, dims) {
  const stale = sig.raw_version !== msgRawVersion;
  const ax = dims.conflict_axis.find(d => d.axis_code === sig.axis_code);
  return {
    id: sig.id, axis_code: sig.axis_code, axis_label: ax ? ax.label : null,
    intent_code: sig.intent_code, concern_code: sig.concern_code, anchor_code: sig.anchor_code,
    confidence: sig.confidence, signal_status: sig.signal_status,
    raw_version: sig.raw_version, source_message_id: sig.source_message_id, stale
  };
}

/* ---------- 归属校验（强隔离：user_id + 越权 403 / 缺失 404） ---------- */
async function getOwnedMessage(id, uid) {
  const row = await pg.queryOne('SELECT * FROM public.family_message WHERE id = $1', [id]);
  if (!row) throw new ApiError(404, 'E_NOT_FOUND', '消息不存在或已删除');
  if (row.user_id !== uid) throw new ApiError(403, 'E_ROOM_FORBIDDEN', '无权访问该家庭消息');
  return row;
}

/* ===========================================================================
 * EP-01 POST /api/family-messages —— 投递原话（双侧同一管道）
 * ========================================================================= */
router.post('/family-messages', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const body = req.body || {};
  const roomId = body.room_id;
  const senderRole = body.sender_role;
  const rawText = (body.raw_text == null ? '' : String(body.raw_text)).trim();
  if (!roomId) return fail(res, 400, '[E_ROOM_REQUIRED] 缺少 room_id');
  if (!['student', 'father', 'mother', 'teacher'].includes(senderRole)) {
    return fail(res, 400, '[E_ROLE_INVALID] sender_role 非法');
  }
  if (!rawText) return fail(res, 400, '[E_RAW_EMPTY] 原话不能为空');
  if (rawText.length > 2000) return fail(res, 400, '[E_RAW_TOO_LONG] 原话超过 2000 字');

  const direction = deriveDirection(senderRole);
  const autoTranslate = body.auto_translate !== false; // 默认 true
  const row = await pg.queryOne(
    `INSERT INTO public.family_message (user_id, room_id, sender_role, direction, raw_text)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [uid, roomId, senderRole, direction, rawText]
  );
  const shaped = shapeMessage(row);
  const total = (await pg.queryOne('SELECT count(*)::int n FROM public.family_message WHERE user_id = $1', [uid])).n;

  if (autoTranslate) {
    // 同一事务外自动触发一次翻译（失败不阻断投递）；传入 direction 供换位引擎定读者视角
    ct.translateMessage({ id: row.id, raw_text: rawText, raw_version: row.raw_version, direction }).catch(() => {});
  }
  res.json({ code: 200, data: { saved: shaped, total } });
}));

/* ===========================================================================
 * EP-02 GET /api/family-messages —— 房间时间线（分页，内联当前版本信号）
 * ========================================================================= */
router.get('/family-messages', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const roomId = req.query.room_id;
  if (!roomId) return fail(res, 400, '[E_ROOM_REQUIRED] 缺少 room_id');

  const where = ['user_id = $1', 'room_id = $2'];
  const params = [uid, roomId];
  if (req.query.status) { where.push('translation_status = $3'); params.push(req.query.status); }
  const sinceId = parseInt(req.query.since_id, 10);
  if (Number.isInteger(sinceId) && sinceId > 0) {
    where.push('id > $' + (params.length + 1));
    params.push(sinceId);
  }
  const { page, size, offset } = paging(req.query);
  const w = ' WHERE ' + where.join(' AND ');

  const total = (await pg.queryOne('SELECT count(*)::int n FROM public.family_message' + w, params)).n;
  const rows = await pg.query(
    'SELECT * FROM public.family_message' + w + ' ORDER BY created_at ASC, id ASC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2),
    params.concat([size, offset])
  );

  const dims = await ct.getDimensions();
  const list = [];
  for (const row of rows) {
    const msg = shapeMessage(row);
    const sigs = await loadSignals(row.id, row.raw_version, false);
    msg.signals = sigs.map(s => shapeSignal(s, row.raw_version, dims));
    list.push(msg);
  }
  ok(res, list, total, page, size);
}));

/* ===========================================================================
 * EP-03 GET /api/family-messages/:id —— 单条详情
 * ========================================================================= */
router.get('/family-messages/:id', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '[E_PARAM_INVALID] id 非法');

  const row = await getOwnedMessage(id, uid);
  const dims = await ct.getDimensions();
  const msg = shapeMessage(row);
  const sigs = await loadSignals(row.id, row.raw_version, false);
  msg.signals = sigs.map(s => shapeSignal(s, row.raw_version, dims));

  const room = await pg.queryOne(
    `SELECT room_id, max(created_at) AS last_message_at, count(*)::int AS message_count
       FROM public.family_message WHERE user_id = $1 AND room_id = $2 GROUP BY room_id`,
    [uid, row.room_id]
  );
  res.json({ code: 200, data: { message: msg, rooms_related: room || null } });
}));

/* ===========================================================================
 * EP-04 PUT /api/family-messages/:id/raw —— 编辑原话（乐观锁，旧译文失效）
 * ========================================================================= */
router.put('/family-messages/:id/raw', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '[E_PARAM_INVALID] id 非法');
  const body = req.body || {};
  const expected = body.expected_raw_version;
  const rawText = (body.raw_text == null ? '' : String(body.raw_text)).trim();
  if (expected === undefined || expected === null) return fail(res, 400, '[E_PARAM_INVALID] 缺少 expected_raw_version');
  if (!rawText) return fail(res, 400, '[E_RAW_EMPTY] 原话不能为空');
  if (rawText.length > 2000) return fail(res, 400, '[E_RAW_TOO_LONG] 原话超过 2000 字');

  const row = await getOwnedMessage(id, uid);
  if (row.raw_version !== parseInt(expected, 10)) {
    return fail(res, 409, '[E_VERSION_CONFLICT] 原话已被修改，请刷新后重试');
  }
  const updated = await pg.queryOne(
    `UPDATE public.family_message
        SET raw_text = $1,
            raw_version = raw_version + 1,
            raw_edited_at = now(),
            translation_status = 'pending'
      WHERE id = $2 AND user_id = $3 AND raw_version = $4
      RETURNING *`,
    [rawText, id, uid, row.raw_version]
  );
  // 写接口返回的 state 必须与读接口（deriveTranslationState）完全一致：
  // 此前从未翻译过（translation_version 为 NULL）→ 'pending'；有过译文但原话已改 → 'stale'
  const savedState = deriveTranslationState(updated);
  const saved = {
    id: updated.id, raw_text: updated.raw_text, raw_version: updated.raw_version,
    raw_edited_at: updated.raw_edited_at, translation_status: updated.translation_status,
    translation_version: updated.translation_version,
    translation_text: publicTranslationText(updated, savedState),
    translation_state: savedState
  };
  res.json({ code: 200, data: { saved, previous_translation_invalidated: true } });
}));

/* ===========================================================================
 * EP-05 POST /api/family-messages/:id/translate —— 触发/重试翻译（唯一入口）
 * ========================================================================= */
router.post('/family-messages/:id/translate', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '[E_PARAM_INVALID] id 非法');

  const row = await getOwnedMessage(id, uid);
  const result = await ct.translateMessage({ id: row.id, raw_text: row.raw_text, raw_version: row.raw_version, direction: row.direction });

  if (result.state === 'flagged') {
    const shaped = shapeMessage(result.row);
    return res.json({ code: 200, data: { saved: shaped, referral: { type: 'crisis_line', note: '已转介专业支持资源' } } });
  }
  if (result.state === 'failed') {
    return fail(res, 502, '[E_TRANSLATE_FAILED] 译文生成失败，已保留原话，可重试');
  }
  res.json({ code: 200, data: { saved: shapeMessage(result.row), reused: false } });
}));

/* ===========================================================================
 * EP-06 POST /api/family-messages/:id/report —— 举报 / 红线标记
 * ========================================================================= */
router.post('/family-messages/:id/report', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '[E_PARAM_INVALID] id 非法');
  const body = req.body || {};
  const reasonCode = body.reason_code;
  if (!reasonCode) return fail(res, 400, '[E_FLAG_REASON_REQUIRED] 缺少 reason_code');

  const row = await getOwnedMessage(id, uid);
  const updated = await ct.flagMessage(row.id, 'user:' + String(reasonCode), 'user');
  res.json({ code: 200, data: { flagged: true, message_id: row.id, flag_reason: updated.flag_reason } });
}));

/* ===========================================================================
 * EP-07 POST /api/family-messages/:id/extract-signal —— 触发职业信号抽取
 * ========================================================================= */
router.post('/family-messages/:id/extract-signal', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '[E_PARAM_INVALID] id 非法');

  const row = await getOwnedMessage(id, uid);
  const result = await ct.extractCareerSignal({ id: row.id, raw_text: row.raw_text, raw_version: row.raw_version, direction: row.direction });
  res.json({ code: 200, data: { message_id: result.message_id, raw_version: result.raw_version, signals: result.signals } });
}));

/* ===========================================================================
 * EP-08 GET /api/family-messages/:id/signals —— 读取信号
 * ========================================================================= */
router.get('/family-messages/:id/signals', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '[E_PARAM_INVALID] id 非法');

  const row = await getOwnedMessage(id, uid);
  const dims = await ct.getDimensions();
  const includeStale = req.query.include_stale === 'true' || req.query.include_stale === '1';
  const sigs = await loadSignals(row.id, row.raw_version, includeStale);
  const list = sigs.map(s => shapeSignal(s, row.raw_version, dims));
  ok(res, list, list.length, 1, list.length || 1);
}));

/* ===========================================================================
 * EP-09 POST /api/family-rooms —— Non-goal（本期不实现）
 * ========================================================================= */
router.post('/family-rooms', ah(async (req, res) => {
  fail(res, 501, '[E_NOT_IMPLEMENTED] 房间由消息派生，无需创建');
}));

/* ===========================================================================
 * EP-10 GET /api/family-rooms —— 房间列表（由消息 GROUP BY 派生）
 * ========================================================================= */
router.get('/family-rooms', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const { page, size, offset } = paging(req.query);
  const rows = await pg.query(
    `SELECT room_id,
            max(created_at) AS last_message_at,
            count(*)::int AS message_count
       FROM public.family_message
      WHERE user_id = $1
      GROUP BY room_id
      ORDER BY last_message_at DESC
      LIMIT $2 OFFSET $3`,
    [uid, size, offset]
  );
  const total = (await pg.queryOne(
    'SELECT count(*)::int n FROM (SELECT 1 FROM public.family_message WHERE user_id = $1 GROUP BY room_id) t',
    [uid]
  )).n;
  ok(res, rows, total, page, size);
}));

/* ===========================================================================
 * EP-11 GET /api/family-dimensions —— 4 张枚举维表（进程内缓存，只读）
 * ========================================================================= */
router.get('/family-dimensions', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const dims = await ct.getDimensions();
  res.json({ code: 200, data: dims });
}));

/* ===========================================================================
 * EP-12 PUT /api/family-messages/:id/folded —— 切换原话折叠态（P1 可选）
 * ========================================================================= */
router.put('/family-messages/:id/folded', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '[E_PARAM_INVALID] id 非法');
  const body = req.body || {};
  const folded = !!body.folded;

  const row = await getOwnedMessage(id, uid);
  const updated = await pg.queryOne(
    'UPDATE public.family_message SET folded = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [folded, id, uid]
  );
  res.json({ code: 200, data: { saved: { id: updated.id, folded: updated.folded } } });
}));

/* ===========================================================================
 * EP-13 / EP-14 / EP-15 —— 双志愿表对比（W4，方案 (e) 跨库应用层拼装）
 * ---------------------------------------------------------------------------
 * 数据源裁决（契约 §12.8 最终版）：
 *   - 学生侧：只读容器 SQLite `volunteers`（SQLite 无 owner_role 列，行一律视作
 *     owner_role='student'；不为 SQLite 加列、不改 init_db.js / init_v2.js）。
 *   - 父/母/老师侧：读写 PG `public.volunteers`（带 owner_role；唯一键
 *     (user_id, owner_role, kind, ref_id)）。
 *   - 两库只在应用层合并，禁 SQL JOIN；两侧行都自带 name/province/city/level/
 *     type/score/adjusted_score，直接读存储列，colleges/majors 仅在补缺时查。
 * ========================================================================= */

/* ---------- 容器 SQLite 只读连接（与 server.js 共用同一 gkzy.db 文件） ---------- */
let _sqlite = null;
function sqliteDb() {
  if (_sqlite) return _sqlite;
  try {
    const file = path.join(__dirname, '..', 'gkzy.db');
    _sqlite = new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    _sqlite = null;
  }
  return _sqlite;
}

const ROLES = ['student', 'father', 'mother', 'teacher'];
const ROLE_ORDER = { student: 0, father: 1, mother: 2, teacher: 3 };

/* ---------- 志愿行整形（唯一 snake→返回体映射落点，routes-d 内） ---------- */
function shapeVolRow(row, ownerRole) {
  return {
    owner_role: ownerRole,
    kind: row.kind,
    ref_id: row.ref_id,
    name: row.name || '',
    province: row.province || '',
    city: row.city || '',
    level: row.level || '',
    type: row.type || '',
    score: Number(row.score) || 0,
    adjusted_score: Number(row.adjusted_score) || 0
  };
}

/* ---------- 取数（单角色）：student→SQLite，其余→PG ---------- */
async function loadRoleVolunteers(uid, role) {
  if (role === 'student') {
    const db = sqliteDb();
    let rows = [];
    if (db) {
      try {
        rows = db.prepare('SELECT * FROM volunteers WHERE user_id = ? ORDER BY id ASC').all(uid);
      } catch (e) { rows = []; }
    }
    return rows.map(r => shapeVolRow(r, 'student'));
  }
  const rows = await pg.query(
    'SELECT * FROM public.volunteers WHERE user_id = $1 AND owner_role = $2 ORDER BY kind ASC, ref_id ASC',
    [uid, role]
  );
  return rows.map(r => shapeVolRow(r, role));
}

/* ---------- 取数（非学生三角色一次性） ---------- */
async function loadNonStudentVolunteers(uid) {
  const rows = await pg.query(
    'SELECT * FROM public.volunteers WHERE user_id = $1 AND owner_role = ANY($2) ORDER BY owner_role ASC, kind ASC, ref_id ASC',
    [uid, ['father', 'mother', 'teacher']]
  );
  return rows.map(r => shapeVolRow(r, r.owner_role));
}

function sortByRoleThenKey(list) {
  list.sort((a, b) => {
    const ro = (ROLE_ORDER[a.owner_role] || 0) - (ROLE_ORDER[b.owner_role] || 0);
    if (ro !== 0) return ro;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return (Number(a.ref_id) || 0) - (Number(b.ref_id) || 0);
  });
  return list;
}

/* ===========================================================================
 * EP-13 GET /api/family-volunteers —— 读某角色（或全部角色）的志愿表
 * ---------------------------------------------------------------------------
 * ★ 偏差（契约 §12.5 / §12.8 显式接受）：L3 规定 PG 不可达 → 整个 D 域 503。
 *   但本端点「显式 owner_role='student'」时只需 SQLite，根本不依赖 PG；若照字面
 *   返回 503，会让方案 (e) 的「学生侧读容器 SQLite」这条最常见主线被 L3 假死。
 *   故：显式 owner_role='student' → 只查 SQLite，PG.isReady()===false 也正常 200；
 *        缺省（四角色全量）或含非学生角色 → 走现成 notReady(res) 503。
 *   不新增响应字段、不加 degraded 标志、不改 notReady()。
 * ========================================================================= */
router.get('/family-volunteers', ah(async (req, res) => {
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const role = req.query.owner_role;
  if (role != null && role !== '' && !ROLES.includes(role)) {
    return fail(res, 400, '[E_ROLE_INVALID] owner_role 非法');
  }

  let list;
  if (role === 'student') {
    // 仅学生侧：只读 SQLite，不依赖 PG
    list = await loadRoleVolunteers(uid, 'student');
  } else if (role) {
    // 显式非学生角色：需 PG
    if (!pg.isReady()) return notReady(res);
    list = await loadRoleVolunteers(uid, role);
  } else {
    // 缺省：四角色全量（SQLite 学生 + PG 非学生），需 PG
    if (!pg.isReady()) return notReady(res);
    const student = await loadRoleVolunteers(uid, 'student');
    const others = await loadNonStudentVolunteers(uid);
    list = student.concat(others);
  }

  sortByRoleThenKey(list);
  const { page, size, offset } = paging(req.query);
  const total = list.length;
  const paged = list.slice(offset, offset + size);
  ok(res, paged, total, page, size);
}));

/* ===========================================================================
 * EP-14 GET /api/family-volunteers/compare —— 双志愿表对比（role_a vs role_b）
 *   纯派生、绝不落库；对齐键 (kind, ref_id)；三桶稳定排序；单体信封。
 * ========================================================================= */
router.get('/family-volunteers/compare', ah(async (req, res) => {
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const roleA = req.query.role_a;
  const roleB = req.query.role_b;
  if (!roleA || !roleB || !ROLES.includes(roleA) || !ROLES.includes(roleB)) {
    return fail(res, 400, '[E_PARAM_INVALID] role_a / role_b 非法或缺失');
  }
  if (roleA === roleB) {
    return fail(res, 400, '[E_PARAM_INVALID] role_a 与 role_b 不能相同');
  }
  // 任一非 student 角色即需 PG（两角色相等 student 已在前一步排除），故统一要求 PG
  if (!pg.isReady()) return notReady(res);

  const listA = await loadRoleVolunteers(uid, roleA);
  const listB = await loadRoleVolunteers(uid, roleB);

  const keyOf = r => String(r.kind) + ' ' + String(r.ref_id);
  const mapA = new Map(listA.map(r => [keyOf(r), r]));
  const mapB = new Map(listB.map(r => [keyOf(r), r]));
  const keysA = new Set(mapA.keys());
  const keysB = new Set(mapB.keys());

  const onlyA = [];
  const onlyB = [];
  const both = [];
  keysA.forEach(k => {
    if (keysB.has(k)) {
      const a = mapA.get(k), b = mapB.get(k);
      const scoreDiffers = (a.score !== b.score) || (a.adjusted_score !== b.adjusted_score);
      both.push({
        kind: a.kind, ref_id: a.ref_id, name: a.name,
        province: a.province, city: a.city, level: a.level, type: a.type,
        score_a: a.score, score_b: b.score,
        adjusted_score_a: a.adjusted_score, adjusted_score_b: b.adjusted_score,
        score_differs: scoreDiffers
      });
    } else {
      onlyA.push(mapA.get(k));
    }
  });
  keysB.forEach(k => { if (!keysA.has(k)) onlyB.push(mapB.get(k)); });

  const byKey = (x, y) => {
    if (x.kind !== y.kind) return x.kind < y.kind ? -1 : 1;
    return (Number(x.ref_id) || 0) - (Number(y.ref_id) || 0);
  };
  onlyA.sort(byKey); onlyB.sort(byKey); both.sort(byKey);

  const counts = {
    only_a: onlyA.length, only_b: onlyB.length, both: both.length,
    total_a: listA.length, total_b: listB.length
  };

  res.json({ code: 200, data: { user_id: uid, role_a: roleA, role_b: roleB, only_a: onlyA, only_b: onlyB, both, counts } });
}));

/* ===========================================================================
 * EP-15 POST /api/family-volunteers —— 写入某角色一条志愿（仅非 student，落 PG）
 * ========================================================================= */
router.post('/family-volunteers', ah(async (req, res) => {
  const uid = requireUid(req);
  if (uid === null) return fail(res, 400, '[E_IDENTITY_MISSING] 缺少 userId');
  const body = req.body || {};
  const ownerRole = body.owner_role;
  if (!ownerRole || !ROLES.includes(ownerRole)) {
    return fail(res, 400, '[E_ROLE_INVALID] owner_role 非法或缺失');
  }
  // ★ 死口径：学生侧写入只走既有 /api/upload，D 域不接受
  if (ownerRole === 'student') {
    return fail(res, 400, '[E_STUDENT_WRITE_VIA_MAIN] 学生侧写入只走既有 /api/upload，D 域不接受');
  }
  const kind = body.kind;
  const refId = parseInt(body.refId, 10);
  if (kind !== 'college' && kind !== 'major') {
    return fail(res, 400, 'kind 只能是 college 或 major');
  }
  if (!Number.isInteger(refId) || refId <= 0) {
    return fail(res, 400, 'refId 必须是正整数');
  }
  if (!pg.isReady()) return notReady(res);

  // 名称/定位等权威字段从容器 SQLite 源表取（与既有 /api/upload 同口径）
  const db = sqliteDb();
  const table = kind === 'college' ? 'colleges' : 'majors';
  let src = null;
  if (db) { try { src = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(refId); } catch (e) {} }
  if (!src) return fail(res, 404, '要加入志愿表的' + (kind === 'college' ? '院校' : '专业') + '不存在，id = ' + refId);

  const adjRaw = body.payload && body.payload.adjustedScore;
  const adjusted = (adjRaw != null) ? (Number(adjRaw) || 0) : (Number(src.score) || 0);

  const payloadStr = (() => { try { return JSON.stringify(body.payload || {}).slice(0, 20000); } catch (e) { return '{}'; } })();

  const cols = {
    name: String(src.name || ''), province: String(src.province || ''),
    city: String(src.city || ''), level: String(src.level || ''),
    type: String(src.type || ''), score: Number(src.score) || 0, adjusted_score: adjusted
  };

  // upsert：唯一键 (user_id, owner_role, kind, ref_id)；冲突即更新、duplicated=true
  const existing = await pg.queryOne(
    'SELECT id FROM public.volunteers WHERE user_id = $1 AND owner_role = $2 AND kind = $3 AND ref_id = $4',
    [uid, ownerRole, kind, refId]
  );
  let saved, duplicated;
  if (existing) {
    saved = await pg.queryOne(
      'UPDATE public.volunteers SET name=$1, province=$2, city=$3, level=$4, type=$5, score=$6, adjusted_score=$7, payload=$8 WHERE id=$9 RETURNING *',
      [cols.name, cols.province, cols.city, cols.level, cols.type, cols.score, cols.adjusted_score, payloadStr, existing.id]
    );
    duplicated = true;
  } else {
    saved = await pg.queryOne(
      'INSERT INTO public.volunteers (user_id, owner_role, kind, ref_id, name, province, city, level, type, score, adjusted_score, payload) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [uid, ownerRole, kind, refId, cols.name, cols.province, cols.city, cols.level, cols.type, cols.score, cols.adjusted_score, payloadStr]
    );
    duplicated = false;
  }

  const total = (await pg.queryOne('SELECT count(*)::int n FROM public.volunteers WHERE user_id = $1 AND owner_role = $2', [uid, ownerRole])).n;
  res.json({ code: 200, data: { saved: shapeVolRow(saved, ownerRole), total, duplicated } });
}));

/* ---------- 导出（含测试用）：PG 连接错误判定 + 异步包装（加固自测用） ---------- */
module.exports = router;
module.exports.isPgConnectionError = isPgConnectionError;
module.exports.ah = ah;
module.exports.notReady = notReady;
