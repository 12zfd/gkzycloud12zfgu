'use strict';

/* ============================================================================
 * services/auth.js —— 用户登录 / 会话 / 用户数据安放架构（B 域·用户）
 * ---------------------------------------------------------------------------
 * 职责（本期范围，详见 spec-user-data-architecture-2026-10-17.md）：
 *   · ensureSchema()        —— 幂等建表（13_users.sql），进程内只跑一次，
 *                              任何异常都吞掉，绝不抛 / 绝不阻塞请求。
 *   · ensureDemoUser()      —— 演示虚拟账号 demo / demo123（is_virtual=true），
 *                              已存在则跳过。
 *   · hashPassword()        —— node:crypto scryptSync + 随机 salt，绝不明文。
 *   · login()               —— 校验账号密码，成功发 30 天有效期 token。
 *   · verifyToken()         —— 按 token 取用户，校验 expires_at；过期/缺失返回 null。
 *   · logout()              —— 注销会话（删 token）。
 *
 * 纪律（与 consensus.js / routes-d 一致）：
 *   · 缺 DATABASE_URL（isReady()=false）时所有函数返回降级值，绝不崩。
 *   · 任何对外响应对象都绝不携带 password_hash。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const pg = require('../repo/pg');

/* 演示账号（虚拟体验账号，一键体验） */
const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo123';
const DEMO_DISPLAY_NAME = '体验用户';

/* 会话有效期：30 天 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* 进程内只执行一次的建表 Promise 缓存 */
let schemaPromise = null;
let schemaOk = false;

/**
 * 幂等建表：读取 13_users.sql 整段执行（simple query 支持多语句）。
 *   - 模块级 Promise 缓存 → 整个进程只跑一次。
 *   - 任何异常都吞掉（schemaOk=false），绝不抛出、绝不阻塞请求。
 */
function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    try {
      const sqlPath = path.join(__dirname, '..', 'sql', '13_users.sql');
      let sql;
      try {
        sql = fs.readFileSync(sqlPath, 'utf8');
      } catch (e) {
        schemaOk = false;
        return;
      }
      await pg.query(sql);
      schemaOk = true;
    } catch (e) {
      schemaOk = false;
    }
  })();
  return schemaPromise;
}

/* ---------- 密码哈希（scryptSync + 随机 salt，绝不明文） ---------- */
const SCRYPT_KEYLEN = 64;

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), useSalt, SCRYPT_KEYLEN).toString('hex');
  // 存储格式： scrypt$<salt>$<hash>
  return 'scrypt$' + useSalt + '$' + derived;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1];
  const expected = parts[2];
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  // 定长比较，避免时序侧信道
  const a = Buffer.from(derived);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------- 用户整形（对外绝不带 password_hash） ---------- */
function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    display_name: row.display_name || '',
    role: row.role || 'student',
    is_virtual: !!row.is_virtual,
    created_at: row.created_at || null
  };
}

/* ---------- 演示虚拟账号（存在则跳过） ---------- */
async function ensureDemoUser() {
  try {
    await ensureSchema();
    if (!pg.isReady()) return null;
    const exists = await pg.queryOne(
      'select id from public.app_users where username = $1',
      [DEMO_USERNAME]
    );
    if (exists) return exists;
    const hash = hashPassword(DEMO_PASSWORD);
    const row = await pg.queryOne(
      `insert into public.app_users (username, password_hash, display_name, role, is_virtual)
       values ($1,$2,$3,'student',true)
       on conflict (username) do nothing
       returning id`,
      [DEMO_USERNAME, hash, DEMO_DISPLAY_NAME]
    );
    return row || exists;
  } catch (e) {
    return null;
  }
}

/* ---------- 登录：成功返回 { token, user }，失败返回 null ---------- */
async function login(username, password) {
  try {
    await ensureSchema();
    if (!pg.isReady()) return null;
    const row = await pg.queryOne(
      'select * from public.app_users where username = $1',
      [String(username || '')]
    );
    if (!row) return null;
    if (!verifyPassword(password, row.password_hash)) return null;

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pg.queryOne(
      `insert into public.user_sessions (token, user_id, expires_at)
       values ($1,$2,$3)
       on conflict (token) do update set user_id = excluded.user_id, expires_at = excluded.expires_at
       returning token`,
      [token, Number(row.id), expiresAt]
    );
    return { token, user: publicUser(row) };
  } catch (e) {
    return null;
  }
}

/* ---------- 按 token 取用户（校验过期）；无/过期/异常 → null ---------- */
async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    await ensureSchema();
    if (!pg.isReady()) return null;
    const sess = await pg.queryOne(
      'select * from public.user_sessions where token = $1',
      [token]
    );
    if (!sess) return null;
    // expires_at 在 PG 中可能是 Date 或字符串，统一转 Date 比较
    const exp = sess.expires_at ? new Date(sess.expires_at) : null;
    if (!exp || isNaN(exp.getTime()) || exp.getTime() < Date.now()) {
      // 过期：顺手清理
      try { await pg.query('delete from public.user_sessions where token = $1', [token]); } catch (e) {}
      return null;
    }
    const row = await pg.queryOne(
      'select * from public.app_users where id = $1',
      [Number(sess.user_id)]
    );
    if (!row) return null;
    return publicUser(row);
  } catch (e) {
    return null;
  }
}

/* ---------- 注销会话 ---------- */
async function logout(token) {
  try {
    if (!token || !pg.isReady()) return false;
    await pg.query('delete from public.user_sessions where token = $1', [String(token)]);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  ensureSchema,
  ensureDemoUser,
  hashPassword,
  verifyPassword,
  login,
  verifyToken,
  logout,
  publicUser,
  DEMO_USERNAME,
  DEMO_PASSWORD,
  DEMO_DISPLAY_NAME,
  SESSION_TTL_MS
};
