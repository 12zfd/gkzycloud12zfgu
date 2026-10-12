'use strict';

/* ============================================================================
 * services/careerTranslate.js —— D 域（家庭协同）唯一收口模块
 * ---------------------------------------------------------------------------
 * 导出三个唯一写入方（单点）：
 *   · translateMessage(msg)        —— translation_text 唯一写入函数
 *   · flagMessage(msgId,reason,by)  —— flag 列（is_flagged/flag_reason/status='flagged'）唯一写入点
 *   · extractCareerSignal(msg)      —— message_career_signal 唯一写入函数
 *
 * ★ 模型接入待后续补，占位实现只产出 failed 状态。
 *   MODEL_ADAPTER 占位实现：模型不可用时 translateMessage 必须把
 *   translation_status 落为 'failed' 且 translation_text = NULL；
 *   绝不生成任何伪造译文（降级绝不"原话直发"）。
 *
 * 纪律（PRD §11.10 / 接口契约 §6）：
 *   · 译文只进展示层，绝不进任何提取/计算管道；
 *   · 信号与翻译互不写入对方产物；
 *   · 读方只读不重算（路由层禁止直接 UPDATE translation_* / is_flagged）。
 * ========================================================================== */

const pg = require('../repo/pg');
const rules = require('./translatorRules');

/* 域级错误：携带 HTTP 状态与业务码（[E_XXX] 前缀由路由拼接进 message） */
class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ---------------------------------------------------------------- *
 * 进程内只读维表缓存（4 张 dim_*，共 22 行；懒加载、只读）
 * ---------------------------------------------------------------- */
let dimCache = null;

function _bucket(sql, codeCol) {
  return pg.query(sql).then(rows => ({
    rows,
    codes: new Set(rows.map(r => r[codeCol]))
  }));
}

async function loadDimCache() {
  if (dimCache) return dimCache;
  const empty = (codeCol) => ({ rows: [], codes: new Set() });
  if (!pg.isReady()) {
    dimCache = {
      conflict_axis: empty(), career_intent: empty(),
      parent_concern: empty(), common_anchor: empty()
    };
    return dimCache;
  }
  dimCache = {
    conflict_axis:  await _bucket("SELECT axis_code,label,direction_desc,active,seq FROM public.dim_conflict_axis ORDER BY seq", 'axis_code'),
    career_intent:  await _bucket("SELECT intent_code,label,riasec_tag,major_cluster,active,seq FROM public.dim_career_intent ORDER BY seq", 'intent_code'),
    parent_concern: await _bucket("SELECT concern_code,label,category,active,seq FROM public.dim_parent_concern ORDER BY seq", 'concern_code'),
    common_anchor:  await _bucket("SELECT anchor_code,label,anchor_type,active,seq FROM public.dim_common_anchor ORDER BY seq", 'anchor_code')
  };
  return dimCache;
}

/** EP-11 用：返回 4 张维表全量行（进程内缓存，只读） */
async function getDimensions() {
  const c = await loadDimCache();
  return {
    conflict_axis:  c.conflict_axis.rows,
    career_intent:  c.career_intent.rows,
    parent_concern: c.parent_concern.rows,
    common_anchor:  c.common_anchor.rows
  };
}

/* ---------------------------------------------------------------- *
 * 红线前置门（确定性 6 条规则，命中返回红线条码 → 上层写 flagged）
 * ---------------------------------------------------------------- */
function _redLineCheck(rawText) {
  return rules.redLineCheck(rawText); // 返回 null 或 code（sys:<code> 由调用方拼接）
}

/* ---------------------------------------------------------------- *
 * 唯一 flag 写入点
 * ---------------------------------------------------------------- */
async function flagMessage(msgId, reason, by) {
  // 只写 is_flagged / flag_reason / translation_status='flagged'
  // 绝不写 translation_text（读层在 flagged 时把 translation_text 显示成 null）
  const row = await pg.queryOne(
    `UPDATE public.family_message
        SET is_flagged = true,
            flag_reason = $1,
            translation_status = 'flagged'
      WHERE id = $2
      RETURNING *`,
    [reason, msgId]
  );
  return row;
}

/* ---------------------------------------------------------------- *
 * 唯一 translation_text 写入方
 * ---------------------------------------------------------------- */
async function translateMessage(msg) {
  const rawText = msg.raw_text;
  const direction = msg.direction; // child_to_parent | parent_to_child（服务端防伪推导，见 routes-d）

  // 1) 红线前置门（命中 → 写 flagged，不产出译文）
  const redLine = _redLineCheck(rawText);
  if (redLine) {
    await flagMessage(msg.id, 'sys:' + redLine, 'sys');
    const row = await pg.queryOne('SELECT * FROM public.family_message WHERE id = $1', [msg.id]);
    return { state: 'flagged', row };
  }

  // 2) 只把 raw_text 当输入（绝不把译文当输入）；方向决定读者视角（双向对称）
  const res = rules.translate(rawText, direction);
  if (res && res.ok) {
    const dims = await loadDimCache();
    const text = rules.renderFourPart(res.parsed, dims, direction);
    const row = await pg.queryOne(
      `UPDATE public.family_message
          SET translation_text      = $1,
              translation_version   = $2,
              translation_status    = 'done',
              translation_engine    = $3,
              translated_by         = $4
        WHERE id = $5
        RETURNING *`,
      [text, msg.raw_version, res.engine || 'rules@1.0.0', 'auto', msg.id]
    );
    return { state: 'done', row };
  }

  // 3) L2：未命中任何规则 → failed，translation_text 必须 NULL，绝不伪造译文（绝不原话直发）
  const row = await pg.queryOne(
    `UPDATE public.family_message
        SET translation_status = 'failed',
            translation_text   = NULL
      WHERE id = $1
      RETURNING *`,
    [msg.id]
  );
  return { state: 'failed', row };
}

/* ---------------------------------------------------------------- *
 * 唯一 message_career_signal 写入方
 * ---------------------------------------------------------------- */
async function extractCareerSignal(msg) {
  const rawText = msg.raw_text;
  const direction = msg.direction; // child_to_parent | parent_to_child
  const cache = await loadDimCache();

  const res = rules.extractSignals(rawText, direction);
  const signals = (res && Array.isArray(res.signals)) ? res.signals : [];

  // 枚举封闭校验：非空槽位必须命中 dim_*（越界 → 422）
  for (const s of signals) {
    if (s.axis_code    && !cache.conflict_axis.codes.has(s.axis_code))    throw new DomainError(422, 'E_ENUM_OUT_OF_RANGE', '冲突轴越界：' + s.axis_code);
    if (s.intent_code  && !cache.career_intent.codes.has(s.intent_code))  throw new DomainError(422, 'E_ENUM_OUT_OF_RANGE', '职业意向越界：' + s.intent_code);
    if (s.concern_code && !cache.parent_concern.codes.has(s.concern_code)) throw new DomainError(422, 'E_ENUM_OUT_OF_RANGE', '家长担忧越界：' + s.concern_code);
    if (s.anchor_code  && !cache.common_anchor.codes.has(s.anchor_code))  throw new DomainError(422, 'E_ENUM_OUT_OF_RANGE', '共同锚点越界：' + s.anchor_code);
  }

  // 按 (message_id, raw_version) 先删后写（替换语义）
  await pg.transaction(async (client) => {
    await client.query(
      'DELETE FROM public.message_career_signal WHERE message_id = $1 AND raw_version = $2',
      [msg.id, msg.raw_version]
    );
    for (const s of signals) {
      await client.query(
        `INSERT INTO public.message_career_signal
           (message_id, source_message_id, raw_version, axis_code, intent_code,
            concern_code, anchor_code, confidence, signal_status, extractor_engine)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          msg.id, msg.id, msg.raw_version,
          s.axis_code || null, s.intent_code || null,
          s.concern_code || null, s.anchor_code || null,
          (s.confidence == null) ? null : s.confidence,
          s.signal_status || 'done', s.extractor_engine || 'placeholder@0'
        ]
      );
    }
  });

  return { message_id: msg.id, raw_version: msg.raw_version, signals };
}

module.exports = {
  DomainError,
  translateMessage,
  flagMessage,
  extractCareerSignal,
  getDimensions,
  loadDimCache
};
