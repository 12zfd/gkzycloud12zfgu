'use strict';

/* ============================================================================
 * routes-auth/index.js —— 用户登录 / 会话（B 域·用户）Express 路由
 * ---------------------------------------------------------------------------
 * 挂载方式（server.js 末尾加 1 行，位于既有 /api 路由之后、catch-all 404 之前）：
 *   app.use('/api', require('./routes-auth'));
 *
 * 复用「既有信封」：本文件【本地定义】 ok()/fail()/paging()/notReady()/ah()，
 * 字段名与写法逐字沿用 routes-d（避免循环依赖、保持降级形状一致）。
 *
 * 端点：
 *   POST /api/auth/login   { username, password }
 *   POST /api/auth/demo    （确保演示账号存在并登录）
 *   GET  /api/auth/me      Authorization: Bearer <token>
 *   POST /api/auth/logout  { token } 或 Authorization: Bearer <token>
 *
 * 降级：DATABASE_URL 未配置（isReady()=false）时，所有端点一律
 *   503 + [E_SERVICE_WAKING] + Retry-After: 30；绝不崩。
 * 红线：任何响应对象都绝不携带 password_hash。
 * ========================================================================== */

const express = require('express');
const pg = require('../repo/pg');
const auth = require('../services/auth');

const router = express.Router();

/* ---------- 本地信封（逐字沿用 routes-d，避免循环依赖） ---------- */
function ok(res, data) {
  res.json({ code: 200, data: data === undefined ? null : data });
}
function fail(res, status, message) {
  res.status(status).json({ code: status, message: String(message || '服务器内部错误') });
}

/* ---------- 未就绪闸门（L3 降级） ---------- */
function notReady(res) {
  res.set('Retry-After', '30');
  fail(res, 503, '[E_SERVICE_WAKING] 服务唤醒中，约需 30 秒，请稍后重试');
  return true;
}

/* ---------- PG 连接类错误码（已配置但握手/连接失败 → 视为服务未就绪） ---------- */
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
      if (err && err.code && isPgConnectionError(err.code)) {
        notReady(res);
        return;
      }
      fail(res, 500, '服务器内部错误');
    });
  };
}

/* ---------- 从 Authorization: Bearer <token> 取 token ---------- */
function bearerToken(req) {
  const h = req.headers && req.headers['authorization'];
  if (h && typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
    return h.slice(7).trim();
  }
  return null;
}

/* ===========================================================================
 * POST /api/auth/login —— 账号密码登录
 * ========================================================================= */
router.post('/auth/login', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const body = req.body || {};
  const username = (body.username == null ? '' : String(body.username)).trim();
  const password = body.password == null ? '' : String(body.password);
  if (!username || !password) {
    return fail(res, 400, '[E_AUTH_CREDENTIALS_REQUIRED] 请输入账号和密码');
  }
  const result = await auth.login(username, password);
  if (!result) {
    return fail(res, 401, '[E_AUTH_INVALID] 账号或密码错误');
  }
  ok(res, { token: result.token, user: result.user });
}));

/* ===========================================================================
 * POST /api/auth/demo —— 演示虚拟账号一键体验（确保 demo 存在并登录）
 * ========================================================================= */
router.post('/auth/demo', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  await auth.ensureDemoUser();
  const result = await auth.login(auth.DEMO_USERNAME, auth.DEMO_PASSWORD);
  if (!result) {
    return fail(res, 401, '[E_AUTH_DEMO_FAILED] 体验账号登录失败，请稍后重试');
  }
  ok(res, { token: result.token, user: result.user });
}));

/* ===========================================================================
 * GET /api/auth/me —— 当前登录用户（Bearer token）
 * ========================================================================= */
router.get('/auth/me', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const token = bearerToken(req);
  if (!token) return fail(res, 401, '[E_AUTH_TOKEN_MISSING] 未登录或登录已过期');
  const user = await auth.verifyToken(token);
  if (!user) return fail(res, 401, '[E_AUTH_TOKEN_INVALID] 未登录或登录已过期');
  ok(res, { user });
}));

/* ===========================================================================
 * POST /api/auth/logout —— 注销（token 在 body 或 Bearer）
 * ========================================================================= */
router.post('/auth/logout', ah(async (req, res) => {
  if (!pg.isReady()) return notReady(res);
  const body = req.body || {};
  const token = (body.token && String(body.token)) || bearerToken(req);
  if (!token) return fail(res, 400, '[E_AUTH_TOKEN_MISSING] 缺少 token');
  await auth.logout(token);
  ok(res, { logged_out: true });
}));

module.exports = router;
module.exports.notReady = notReady;
module.exports.ah = ah;
module.exports.isPgConnectionError = isPgConnectionError;
