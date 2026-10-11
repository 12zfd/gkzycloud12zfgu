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

/* ---------- 异步 handler 包装（捕获 rejection，避免未处理 Promise） ---------- */
function ah(handler) {
  return (req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(err => {
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
    // 同一事务外自动触发一次翻译（失败不阻断投递）
    ct.translateMessage({ id: row.id, raw_text: rawText, raw_version: row.raw_version }).catch(() => {});
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
  const saved = {
    id: updated.id, raw_text: updated.raw_text, raw_version: updated.raw_version,
    raw_edited_at: updated.raw_edited_at, translation_status: updated.translation_status,
    translation_version: updated.translation_version, translation_text: null,
    translation_state: 'stale'
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
  const result = await ct.translateMessage({ id: row.id, raw_text: row.raw_text, raw_version: row.raw_version });

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
  const result = await ct.extractCareerSignal({ id: row.id, raw_text: row.raw_text, raw_version: row.raw_version });
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

module.exports = router;
