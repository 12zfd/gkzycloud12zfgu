'use strict';

/* ============================================================================
 * services/consensus.js —— D 域（家庭协同）家长三态表态：共识后端能力
 * ---------------------------------------------------------------------------
 * 职责：
 *   · ensureSchema()        —— 幂等建表（12_consensus.sql），进程内只跑一次，
 *                              任何异常都吞掉，绝不抛 / 绝不阻塞请求。
 *   · judgeItem()           —— 纯函数，按 roster 与已表态推导 item 的
 *                              status / condition_text，可单测、不碰库。
 *   · loadRoster()          —— 从 family_message 取应表态角色清单。
 *   · syncItems()           —— consensus_item 的唯一写入方（轴项 + 分歧候选）。
 *   · listConsensus()       —— 读：某房间全部共识项 + 进度。
 *   · putStance()           —— 写入/更新某角色表态 + 重算 item status（唯一判定点）。
 *
 * 纪律（与 routes-d 一致）：
 *   · 缺 DATABASE_URL（isReady()=false）时绝不崩；读接口返回空列表 + 零进度。
 *   · 所有对外异步函数入口先 ensureSchema()（吞错），再干活。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const pg = require('../repo/pg');
const { DomainError } = require('./careerTranslate');

/* 三态枚举与「硬度」：veto > negotiable > accept（用于让步判定） */
const STANCES = ['veto', 'negotiable', 'accept'];
const STANCE_HARDNESS = { veto: 2, negotiable: 1, accept: 0 };

/* 进程内只执行一次的建表 Promise 缓存 */
let schemaPromise = null;
let schemaOk = false;

/**
 * 幂等建表：读取 12_consensus.sql 整段执行。
 *   - 模块级 Promise 缓存 → 整个进程只跑一次。
 *   - 任何异常都吞掉（schemaOk=false），绝不抛出、绝不阻塞请求。
 *   - 文件不存在也不能崩。
 */
function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    try {
      const sqlPath = path.join(__dirname, '..', 'sql', '12_consensus.sql');
      let sql;
      try {
        sql = fs.readFileSync(sqlPath, 'utf8');
      } catch (e) {
        // 文件不存在：标记为未就绪但不崩。
        schemaOk = false;
        return;
      }
      // pg 的 simple query 支持多语句、无参数。
      await pg.query(sql);
      schemaOk = true;
    } catch (e) {
      // 即便建表途中某些语句失败（如 RLS/revoke 在裸 PG 上缺角色），
      // 也只标记未就绪，绝不向上抛出。
      schemaOk = false;
    }
  })();
  return schemaPromise;
}

/**
 * judgeItem —— 纯函数，不碰数据库，可单测。
 *   stances:      [{ role, stance, condition }]
 *   rosterRoles:  应表态角色数组（字符串）
 * 返回 { status, condition_text }，status ∈ 'pending' | 'settled' | 'deferred'。
 *
 * 规则（按顺序）：
 *   ① rosterRoles 为空 → 视为 ['student']
 *   ② roster 中有任一角色没有 stance → pending
 *   ③ 否则存在任一 stance === 'veto' → deferred
 *   ④ 否则存在任一 stance === 'negotiable' → settled，
 *      condition_text = 所有 negotiable 的 condition 去空、去重后用 ' / ' 拼接
 *   ⑤ 否则（全 accept）→ settled，condition_text = ''
 */
function judgeItem(stances, rosterRoles) {
  const roster = (rosterRoles && rosterRoles.length) ? rosterRoles : ['student'];
  const list = Array.isArray(stances) ? stances : [];

  // ② roster 中任一角色没有 stance → pending
  for (const r of roster) {
    const found = list.find(s => s && s.role === r && s.stance);
    if (!found) return { status: 'pending', condition_text: '' };
  }

  // ③ 任一 veto → deferred
  if (list.some(s => s && s.stance === 'veto')) {
    return { status: 'deferred', condition_text: '' };
  }

  // ④ 任一 negotiable → settled（拼接 condition）
  if (list.some(s => s && s.stance === 'negotiable')) {
    const seen = new Set();
    const parts = [];
    for (const s of list) {
      if (s && s.stance === 'negotiable') {
        const c = (s.condition || '').trim();
        if (c !== '' && !seen.has(c)) { seen.add(c); parts.push(c); }
      }
    }
    return { status: 'settled', condition_text: parts.join(' / ') };
  }

  // ⑤ 全 accept → settled
  return { status: 'settled', condition_text: '' };
}

/**
 * loadRoster —— 该房间应表态角色清单（去重 sender_role）。
 *   查不到或出错都返回 ['student']。
 */
async function loadRoster(uid, roomId) {
  try {
    const rows = await pg.query(
      `select distinct sender_role
         from public.family_message
        where user_id = $1 and room_id = $2 and sender_role is not null`,
      [uid, roomId]
    );
    if (!rows || !rows.length) return ['student'];
    return rows.map(r => r.sender_role);
  } catch (e) {
    return ['student'];
  }
}

/**
 * syncItems —— consensus_item 的唯一写入方（轴项 + 分歧候选）。
 *   extraCandidates: 可选 [{ item_type:'college'|'major', ref_key, label, source_role }]
 *                   由 routes-d 算好传进来（学生独有 / 家长侧独有的志愿）。
 *   整段 try/catch 吞异常，返回 void，绝不因同步失败让读接口 500。
 */
async function syncItems(uid, roomId, extraCandidates) {
  try {
    await ensureSchema();

    // 轴项来源：已完成信号里按 axis_code 取最新一条
    const sigRows = await pg.query(
      `select distinct on (s.axis_code) s.axis_code, s.id as message_id, s.raw_version
         from public.message_career_signal s
         join public.family_message m on m.id = s.message_id
        where m.user_id = $1 and m.room_id = $2
          and s.signal_status = 'done' and s.axis_code is not null
        order by s.axis_code, s.id desc`,
      [uid, roomId]
    );

    const candidates = [];
    for (const r of sigRows) {
      // label 一律从 dim_conflict_axis 按 axis_code 取；查不到就跳过这一条
      // （绝不把 A / CI_RESOLUTE 这类内部代码当下发文案）。
      const dim = await pg.queryOne(
        'select label from public.dim_conflict_axis where axis_code = $1',
        [r.axis_code]
      );
      if (!dim || !dim.label) continue;
      candidates.push({
        item_type: 'axis',
        ref_key: r.axis_code,
        label: dim.label,
        source: 'signal',
        source_role: '',
        source_message_id: r.message_id,
        source_raw_version: r.raw_version
      });
    }

    if (Array.isArray(extraCandidates)) {
      for (const c of extraCandidates) {
        if (!c || !c.item_type || !c.ref_key) continue;
        candidates.push({
          item_type: c.item_type,
          ref_key: c.ref_key,
          label: c.label || '',
          /* ★ 候选来自两张志愿表的集合差 → 归 'volunteer_divergence'。
           *   历史上这里一律写 'signal'，会把「志愿分歧」误标成「职业信号」，
           *   后续按来源统计就全错了（表上本来就有这个 check）。 */
          source: c.source || 'volunteer_divergence',
          source_role: c.source_role || '',
          source_message_id: null,
          source_raw_version: null
        });
      }
    }

    // 轴项与分歧候选共用同一条 upsert
    for (const c of candidates) {
      await pg.query(
        `insert into public.consensus_item
           (user_id, room_id, item_type, ref_key, label, source,
            source_message_id, source_raw_version, source_role)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (user_id, room_id, item_type, ref_key)
         do update set label = excluded.label,
                       source = excluded.source,
                       source_role = excluded.source_role,
                       updated_at = now()`,
        [uid, roomId, c.item_type, c.ref_key, c.label, c.source,
         c.source_message_id, c.source_raw_version, c.source_role]
      );
    }
  } catch (e) {
    // 同步失败：吞掉，返回 void
  }
}

/* 进度计数（按 item status 聚合） */
async function progressOf(uid, roomId) {
  try {
    const items = await pg.query(
      'select status from public.consensus_item where user_id = $1 and room_id = $2',
      [uid, roomId]
    );
    const progress = { total: items.length, settled: 0, pending: 0, deferred: 0 };
    for (const it of items) {
      if (it.status === 'settled') progress.settled++;
      else if (it.status === 'pending') progress.pending++;
      else if (it.status === 'deferred') progress.deferred++;
    }
    return progress;
  } catch (e) {
    return { total: 0, settled: 0, pending: 0, deferred: 0 };
  }
}

/**
 * listConsensus —— 读：某房间全部共识项 + 进度。
 *   查表失败（表不存在等）→ 返回空列表 + 零进度，绝不抛。
 */
async function listConsensus(uid, roomId, viewerRole) {
  try {
    await ensureSchema();

    const items = await pg.query(
      `select * from public.consensus_item
        where user_id = $1 and room_id = $2
        order by item_type asc, id asc`,
      [uid, roomId]
    );

    const itemIds = items.map(r => r.id);
    const stancesByItem = {};
    if (itemIds.length) {
      const stances = await pg.query(
        'select * from public.consensus_stance where item_id = any($1)',
        [itemIds]
      );
      for (const s of stances) {
        if (!stancesByItem[s.item_id]) stancesByItem[s.item_id] = [];
        stancesByItem[s.item_id].push(s);
      }
    }

    const viewer = viewerRole || 'student';
    const out = items.map(row => {
      const ss = stancesByItem[row.id] || [];
      const my = ss.find(s => s.role === viewer) || null;
      return {
        item_id: Number(row.id),
        item_type: row.item_type,
        ref_key: row.ref_key,
        label: row.label,
        status: row.status,
        condition_text: row.condition_text,
        // 本版不做匿名揭示，恒为 null（保留字段，前端可直接渲染“待揭示”）
        my_stance: my ? {
          stance: my.stance,
          reason: my.reason,
          substitute: my.substitute,
          no_substitute: my.no_substitute,
          condition: my.condition
        } : null,
        stances: null,
        stance_count: ss.length
      };
    });

    const progress = { total: out.length, settled: 0, pending: 0, deferred: 0 };
    for (const it of out) {
      if (it.status === 'settled') progress.settled++;
      else if (it.status === 'pending') progress.pending++;
      else if (it.status === 'deferred') progress.deferred++;
    }
    return { items: out, progress };
  } catch (e) {
    return { items: [], progress: { total: 0, settled: 0, pending: 0, deferred: 0 } };
  }
}

/**
 * putStance —— 写入/更新某角色表态 + 重算 item status（唯一判定点）。
 * 返回 { saved, item_status, progress }。
 * 校验失败抛出 DomainError（由 routes-d 的 ah() 翻成 fail(res, status, '[code] msg')）。
 */
async function putStance({ uid, roomId, role, itemId, stance, reason, substitute, noSubstitute, condition }) {
  try { await ensureSchema(); } catch (e) {}

  // 1) item_id 非法
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new DomainError(400, 'E_ITEM_INVALID', 'item_id 非法');
  }
  // 2) stance 非法
  if (!STANCES.includes(stance)) {
    throw new DomainError(400, 'E_STANCE_INVALID', 'stance 非法');
  }
  // 3) 查 item + 归属校验
  const item = await pg.queryOne('select * from public.consensus_item where id = $1', [itemId]);
  if (!item) throw new DomainError(404, 'E_ITEM_NOT_FOUND', '共识项不存在');
  if (item.user_id !== uid) throw new DomainError(403, 'E_ITEM_FORBIDDEN', '无权操作该共识项');
  // 4) 裸否决：原因至少 8 字
  if (stance === 'veto' && String(reason || '').trim().length < 8) {
    throw new DomainError(400, 'E_VETO_REASON_REQUIRED', '请说明你担心的原因（至少 8 字）');
  }
  // 5) 裸否决：必须有替代方案或勾选「我没有替代方案」
  if (stance === 'veto' && String(substitute || '').trim() === '' && noSubstitute !== true) {
    throw new DomainError(400, 'E_VETO_SUBSTITUTE_REQUIRED', '请给出替代方案，或勾选『我没有替代方案』');
  }

  // 落库：先查旧值（用于账本让步判定）
  const old = await pg.queryOne(
    'select * from public.consensus_stance where item_id = $1 and role = $2',
    [itemId, role]
  );

  let saved;
  if (old) {
    saved = await pg.queryOne(
      `update public.consensus_stance
          set stance = $1, reason = $2, substitute = $3,
              no_substitute = $4, condition = $5, updated_at = now()
        where item_id = $6 and role = $7
        returning *`,
      [stance, reason || '', substitute || '', !!noSubstitute, condition || '', itemId, role]
    );
  } else {
    saved = await pg.queryOne(
      `insert into public.consensus_stance
         (item_id, user_id, role, stance, reason, substitute, no_substitute, condition)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [itemId, uid, role, stance, reason || '', substitute || '', !!noSubstitute, condition || '']
    );
  }

  // 账本：软化/让步（旧硬度 > 新硬度）才记账；失败不影响主流程
  if (old && STANCE_HARDNESS[old.stance] > STANCE_HARDNESS[stance]) {
    try {
      await pg.query(
        `insert into public.consensus_ledger
           (item_id, user_id, role, stance_from, stance_to)
         values ($1,$2,$3,$4,$5)`,
        [itemId, uid, role, old.stance, stance]
      );
    } catch (e) { /* 记账失败不影响主流程 */ }
  }

  // 重算 status（唯一写入方）：取 roster + 该 item 全部 stances
  const roster = await loadRoster(uid, roomId);
  const all = await pg.query(
    'select role, stance, condition from public.consensus_stance where item_id = $1',
    [itemId]
  );
  const judge = judgeItem(
    all.map(s => ({ role: s.role, stance: s.stance, condition: s.condition })),
    roster
  );
  await pg.query(
    `update public.consensus_item
        set status = $1, condition_text = $2, updated_at = now()
      where id = $3`,
    [judge.status, judge.condition_text, itemId]
  );

  const progress = await progressOf(uid, roomId);
  return {
    saved: {
      item_id: Number(saved.item_id),
      role: saved.role,
      stance: saved.stance,
      reason: saved.reason,
      substitute: saved.substitute,
      no_substitute: saved.no_substitute,
      condition: saved.condition
    },
    item_status: judge.status,
    progress
  };
}

module.exports = {
  ensureSchema,
  judgeItem,
  loadRoster,
  syncItems,
  listConsensus,
  putStance,
  STANCES,
  STANCE_HARDNESS
};
