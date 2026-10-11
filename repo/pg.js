'use strict';

/* ============================================================================
 * repo/pg.js —— D 域（家庭协同）Postgres 连接池（只增，不回改既有 SQLite 域）
 * ---------------------------------------------------------------------------
 * 设计纪律：
 *   1) require 期绝不抛错 —— 线上此刻没有 DATABASE_URL，站点必须照常工作。
 *      未配置 DATABASE_URL 时，isReady() 返回 false，D 域端点统一返回 503。
 *   2) 仅在 DATABASE_URL 存在时才 require('pg')，避免无依赖时加载失败。
 *   3) 只暴露最小接口：isReady() / query() / transaction()，供 routes-d 与
 *      services/careerTranslate.js 使用。
 * ========================================================================== */

const ENV = process.env;

let pool = null;
let ready = false;
let PoolCtor = null;

if (ENV.DATABASE_URL) {
  try {
    const pgMod = require('pg');
    PoolCtor = pgMod.Pool;
    // 06/07 里 id / user_id / ref_id 等全是 bigint（int8）；
    // node-postgres 默认把 int8 当字符串返回，会让 routes-d 的严格比较
    // （row.user_id !== uid）恒为 true → 房主自己被判 403，且 JSON 里 id/user_id
    // 也变字符串，前端 === 比较会翻车。D 域的 bigint 都是自增代理键/小整数，
    // 远低于 2^53，这里统一回变成 number 最省心。
    // 必须在拿到 require('pg') 同一引用后再设，且只在此块内（pg 未安装/未配 URL
    // 时绝不 require），不破坏「无 DATABASE_URL 不许崩」的纪律。
    pgMod.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
    pool = new PoolCtor({
      connectionString: ENV.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    ready = true;
  } catch (e) {
    // 连不上 / pg 未安装：保持未就绪，端点走 503，绝不崩。
    pool = null;
    ready = false;
  }
}

/** 当前是否可连接外部 Postgres（D 域唯一可用性闸门） */
function isReady() {
  return ready && !!pool;
}

/** 执行一条查询，返回 rows 数组 */
async function query(text, params) {
  if (!isReady()) throw new Error('PG_NOT_READY');
  const res = await pool.query(text, params || []);
  return res.rows;
}

/** 取一行（ LIMIT 1 场景） */
async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows && rows.length ? rows[0] : null;
}

/**
 * 事务包装：拿到一个 client，BEGIN → fn(client) → COMMIT；
 * fn 抛错则 ROLLBACK。fn 内请用 client.query(...)。
 */
async function transaction(fn) {
  if (!isReady()) throw new Error('PG_NOT_READY');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* 忽略 */ }
    throw e;
  } finally {
    try { client.release(); } catch (e3) { /* 忽略 */ }
  }
}

module.exports = { isReady, query, queryOne, transaction, getPool: () => pool };
