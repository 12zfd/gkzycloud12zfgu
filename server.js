/* ============================================================================
 * server.js —— 云端后端服务（Node.js + Express + SQLite）
 * ---------------------------------------------------------------------------
 * 适用环境：Hugging Face Spaces（Docker SDK）/ 任意容器 / 本机
 *
 * 与本地版的区别（只有 4 处，逻辑一行未改）：
 *   ① 端口改为 process.env.PORT || 7860（HF Spaces 约定端口）
 *   ② 监听 0.0.0.0（容器内必须绑全网卡，否则外部访问不到；localhost 会连不上）
 *   ③ CORS 显式放行（同域部署其实用不到，但保留以免将来前后端分离时踩坑）
 *   ④ 新增「启动自检」：gkzy.db 不存在 / 是空库时，自动建库并灌满数据
 *      （100 所大学 + 50 个专业 + admission_scores 8525 行等），
 *      这样在云上即使没把 .db 传上去，服务也能自己把数据长出来，绝不空转。
 *
 * 数据库：当前目录下的 gkzy.db。用 Node 自带的 node:sqlite，
 *         不需要安装数据库软件、不需要编译（不会出现 node-gyp 报错）。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const { DatabaseSync } = require('node:sqlite');

/* ===========================================================================
 * 0. 集中配置 —— 全部只在顶部一处，改这里就够
 * ========================================================================= */
const PORT              = Number(process.env.PORT || 7860);   // ① 云上默认 7860
const HOST              = '0.0.0.0';                          // ② 容器内必须绑全网卡
const DB_FILE           = path.join(__dirname, 'gkzy.db');
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX     = 20000;  // 前端首屏「维表拉全量」时用得上（历年录取有 6000+ 行）

/* ===========================================================================
 * 1. 启动自检 —— 数据库不存在 / 是空库，就地自动建库并灌数据
 * ---------------------------------------------------------------------------
 * 这是云端最关键的一道保险：
 *   Hugging Face Spaces 每次重建容器时文件系统可能是干净的，
 *   如果只依赖「你本地上传的那个 gkzy.db」，一旦遗漏就会开出一个空站。
 *   所以这里主动探测：缺表或表里没数据 → 自动跑一遍建库脚本。
 *
 * 三个建库脚本都是幂等的（重复执行不会出错，也不会清掉已有志愿），
 * 因此「数据齐全时直接跳过」，不会每次启动都重灌一遍。
 * ========================================================================= */
function hasTable(db, name) {
  return !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
}
/** 数据库是否「可用」：文件在、关键表在、且院校表里有数据 */
function dbReady() {
  if (!fs.existsSync(DB_FILE)) return false;
  let db;
  try {
    db = new DatabaseSync(DB_FILE);
    const ok = hasTable(db, 'colleges') && hasTable(db, 'majors') && hasTable(db, 'volunteers');
    if (!ok) return false;
    const n = db.prepare('SELECT COUNT(*) AS n FROM colleges').get().n;
    return n > 0;
  } catch (e) {
    return false;
  } finally {
    try { if (db) db.close(); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 跑一个建库脚本。失败时把 stderr 一并带出来，方便在云端日志里定位。
 * 用 execFileSync（同步）：启动流程必须等数据就绪之后再 listen。
 */
function runSeedScript(script, label) {
  const file = path.join(__dirname, script);
  if (!fs.existsSync(file)) {
    console.error('  [自检] 找不到建库脚本 ' + script + '，跳过 ' + label);
    return false;
  }
  console.log('  [自检] 正在执行 ' + script + '（' + label + '）…');
  try {
    const out = execFileSync(process.execPath, [file], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000
    });
    /* 建库脚本会打印一堆行数自检，这里只摘关键几行，避免刷屏 */
    String(out || '').split('\n')
      .filter(l => /行|完成|✔/.test(l))
      .slice(0, 12)
      .forEach(l => console.log('      ' + l.trim()));
    return true;
  } catch (err) {
    console.error('  [自检] ' + script + ' 执行失败：' + (err && err.message));
    const detail = (err && (err.stderr || err.stdout)) ? String(err.stderr || err.stdout).trim() : '';
    if (detail) console.error('      ' + detail.split('\n').slice(0, 6).join('\n      '));
    return false;
  }
}

/**
 * 启动自检总入口。返回 true 表示最终数据库可用。
 * 顺序：init_db.js（基础 7 张表 + 录取分数）→ init_v2.js（专业组 / 历年录取 / 考生）
 */
function ensureDatabase() {
  if (dbReady()) {
    console.log('  [自检] 数据库已就绪，跳过建库。');
    return true;
  }
  console.log('');
  console.log('  [自检] 未检测到可用数据库（文件缺失或为空库），开始自动生成…');
  console.log('  [自检] 首次启动需要十几秒，请稍候。');
  console.log('');

  const a = runSeedScript('init_db.js', '基础表 + 100 所院校 + 录取分数');
  if (!a) return false;

  /* init_v2.js 失败不致命：专业组 / 历年录取是「增强分区」，
     缺了它页面主体（院校 / 专业 / 志愿表）依然可用，所以只告警不退出。 */
  const b = runSeedScript('init_v2.js', '专业组 + 历年录取 + 考生');
  if (!b) {
    console.warn('  [自检] init_v2.js 未成功，页面主体可用，但「招生专业组 / 历年录取」分区会缺失。');
  }

  if (!dbReady()) {
    console.error('  [自检] 自动建库后数据库仍不可用，服务无法启动。');
    return false;
  }
  console.log('');
  console.log('  [自检] 数据库自动生成完成 ✔');
  console.log('');
  return true;
}

if (!ensureDatabase()) {
  console.error('');
  console.error('  [启动失败] 数据库不可用。请检查上面的自检日志。');
  console.error('  常见原因：容器内没有写入权限，或 gkzy.db 是一个损坏的文件。');
  console.error('');
  process.exit(1);
}

/* ===========================================================================
 * 2. 打开数据库
 * ========================================================================= */
let db;
try {
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA foreign_keys = ON');
} catch (err) {
  console.error('[启动失败] 数据库打开失败：' + err.message);
  process.exit(1);
}

/** 表是否存在 —— 用于给出比「no such table」更友好的报错 */
function tableExists(name) {
  return !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
}
if (!tableExists('colleges') || !tableExists('majors')) {
  console.error('');
  console.error('  [启动失败] 数据库里没有 colleges / majors 表。');
  console.error('  请重新运行一次：  node init_db.js');
  console.error('');
  process.exit(1);
}

/* ===========================================================================
 * 3. Express 与应用级中间件
 * ========================================================================= */
const app = express();

/* 3.1 跨域 —— ③ 显式放行。
   同域部署其实用不到（页面与接口同一个域名），但保留以防将来前后端分离。
   这里允许任意来源，因为本站不涉及任何用户隐私数据（本地演示用）。 */
app.use(cors({
  origin: true,                 // 回显请求方的 Origin（等价于允许所有来源）
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept']
}));
/* 预检请求直接 204，省掉一次无意义的二次往返 */
app.options('*', (req, res) => res.sendStatus(204));

/* 3.2 请求体解析 */
app.use(express.json({ limit: '1mb' }));

/* 3.3 请求 ID + 结构化 JSON 日志（一条请求一行，方便排查） */
app.use((req, res, next) => {
  req.id = Math.random().toString(36).slice(2, 10);
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      reqId: req.id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - t0
    }));
  });
  next();
});

/* ===========================================================================
 * 4. 公共工具
 * ========================================================================= */

/**
 * 北京时间字符串（yyyy/MM/dd HH:mm:ss）。
 * 显式指定时区，**不依赖容器进程的默认时区** —— Alpine 基础镜像里
 * `ENV TZ=Asia/Shanghai` 不会被 ICU 采纳（health 的 tz 字段自报 UTC）。
 * ICU 若连 tz 数据都没有（RangeError），按 UTC+8 手算兜底。
 */
function cnNow() {
  const d = new Date();
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(d);
  } catch (e) {
    return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  }
}

/** 统一返回信封 —— 与前端 API.unwrap 的契约一字不差：{ code, data:{ list,total,page,pageSize } } */
function ok(res, list, total, page, pageSize) {
  res.json({ code: 200, data: { list, total, page, pageSize } });
}
/** 统一错误结构：只暴露可读信息，绝不把堆栈吐给客户端 */
function fail(res, status, message) {
  res.status(status).json({ code: status, message: String(message || '服务器内部错误') });
}

/** 分页参数解析 + 校验（绝不信任客户端传来的数字） */
function paging(query) {
  const page = Math.min(100000, Math.max(1, parseInt(query.page, 10) || 1));
  let size   = parseInt(query.size, 10) || PAGE_SIZE_DEFAULT;
  size = Math.min(PAGE_SIZE_MAX, Math.max(1, size));
  return { page, size, offset: (page - 1) * size };
}

/** 文本参数清洗：只取前 60 字，去掉首尾空格 */
function text(v, max = 60) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/** 每个路由的 try/catch 包装 —— 任何一个接口出错都不会让整个服务崩掉 */
function safe(handler) {
  return (req, res, next) => {
    try { handler(req, res, next); }
    catch (err) { next(err); }
  };
}

/* ===========================================================================
 * 5. 业务查询
 * ========================================================================= */

/**
 * 查院校
 * 注意（与前端契约一致）：
 *   - province 是「生源省份」，不是筛选条件（录取概率由前端算），这里不参与过滤
 *   - region 才是「院校所在地」的筛选条件
 */
function queryColleges(q) {
  const keyword = text(q.keyword);
  const region  = text(q.region);
  const level   = text(q.level);
  const sort    = text(q.sort);

  const where = [];
  const args  = [];
  if (keyword) {
    where.push('(name LIKE ? OR abbr LIKE ? OR city LIKE ? OR province LIKE ?)');
    const k = '%' + keyword + '%';
    args.push(k, k, k, k);
  }
  if (region) { where.push('province = ?'); args.push(region); }
  if (level)  { where.push('level = ?');    args.push(level); }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const order = (sort === 'score') ? ' ORDER BY score DESC, id ASC' : ' ORDER BY id ASC';

  const total = db.prepare('SELECT COUNT(*) AS n FROM colleges' + w).get(...args).n;
  const { page, size, offset } = paging(q);
  const list = db.prepare('SELECT * FROM colleges' + w + order + ' LIMIT ? OFFSET ?')
                 .all(...args, size, offset);

  return { list, total, page, size };
}

/** 查专业：默认按就业率降序，同率按 id 升序（与前端本地排序口径一致） */
function queryMajors(q) {
  const keyword  = text(q.keyword);
  const category = text(q.category);

  const where = [];
  const args  = [];
  if (keyword) {
    where.push('(name LIKE ? OR category LIKE ? OR prospect LIKE ? OR subject LIKE ?)');
    const k = '%' + keyword + '%';
    args.push(k, k, k, k);
  }
  if (category) { where.push('category = ?'); args.push(category); }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS n FROM majors' + w).get(...args).n;
  const { page, size, offset } = paging(q);
  const list = db.prepare('SELECT * FROM majors' + w +
                          ' ORDER BY employ_rate DESC, id ASC LIMIT ? OFFSET ?')
                 .all(...args, size, offset);

  return { list, total, page, size };
}

/** 把 volunteers 表的一行整形成前端 State.volunteerList 里那种对象 */
function shapeVolunteer(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch (e) { payload = {}; }
  // 数据库里的权威字段覆盖 payload，保证「以库为准」
  return Object.assign({}, payload, {
    userId:        row.user_id,
    kind:          row.kind,
    id:            row.ref_id,
    name:          row.name,
    province:      row.province,
    city:          row.city,
    level:         row.level,
    type:          row.type,
    score:         row.score,
    adjustedScore: row.adjusted_score
  });
}

/**
 * 当前考生 id。
 * 前端没传（老版本前端 / 手动 curl）时按 1 号考生处理，
 * 这样「多用户」上线不会让原来能用的调用突然失效。
 */
function uid(req) {
  const raw = (req.query && req.query.userId) || (req.body && req.body.userId);
  const n = parseInt(raw, 10);
  return (Number.isInteger(n) && n > 0) ? n : 1;
}

/** 把 admission_histories 的一行整形成前端 API.ADMISSIONS 里那种对象（保留 snake_case，与前端映射一致） */
function shapeAdmission(row) {
  return {
    id:             row.id,
    college_id:     row.college_id,
    major_group_id: row.major_group_id,
    year:           row.year,
    province:       row.province,
    subject_type:   row.subject_type,
    batch:          row.batch,
    min_score:      row.min_score,
    min_rank:       row.min_rank,
    avg_score:      row.avg_score,
    plan_count:     row.plan_count
  };
}

/**
 * 把 admission_scores 的一行整形成前端 API.SCORES 里那种对象。
 * 保留 snake_case —— 与前端 API.fromRowScore() 的映射口径一一对应。
 */
function shapeScore(row) {
  return {
    id:         row.id,
    college_id: row.college_id,
    major_id:   row.major_id,
    year:       row.year,
    min_score:  row.min_score,
    min_rank:   row.min_rank,
    plan_count: row.plan_count
  };
}

/** 把 college_major_groups 的一行整形成前端 API.GROUPS 里那种对象 */
function shapeGroup(row) {
  return {
    id:               row.id,
    college_id:       row.college_id,
    group_code:       row.group_code,
    group_name:       row.group_name,
    subject_required: row.subject_required,
    subject_type:     row.subject_type,
    plan_count:       row.plan_count,
    tuition:          row.tuition,
    batch:            row.batch,
    remark:           row.remark,
    seq:              row.seq
  };
}

/* ===========================================================================
 * 6. 路由
 * ========================================================================= */

/* 6.0 健康检查 —— 用来确认后端活着（云上排查第一步就打这个） */
app.get('/api/health', safe((req, res) => {
  res.json({
    code: 200,
    data: {
      status: 'ok',
      database: path.basename(DB_FILE),
      colleges: db.prepare('SELECT COUNT(*) AS n FROM colleges').get().n,
      majors:   db.prepare('SELECT COUNT(*) AS n FROM majors').get().n,
      volunteers: db.prepare('SELECT COUNT(*) AS n FROM volunteers').get().n,
      majorGroups: db.prepare('SELECT COUNT(*) AS n FROM college_major_groups').get().n,
      admissions:  db.prepare('SELECT COUNT(*) AS n FROM admission_histories').get().n,
      scores:      tableExists('admission_scores')
                     ? db.prepare('SELECT COUNT(*) AS n FROM admission_scores').get().n
                     : 0,
      users:       db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      /* —— 可验证性（阶段 0 验收暴露的缺口）——
       * Render 部署时会注入 RENDER_GIT_COMMIT / RENDER_GIT_BRANCH，
       * 把它回显出来，就能从外部一眼确认「线上跑的是哪个提交」，
       * 不必再靠数据库计数、时区这类间接信号去猜。
       * 本地 direct-run 时这两个变量不存在，回落 'local'。 */
      commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'local',
      branch: process.env.RENDER_GIT_BRANCH || 'local',
      /* 容器时区：TZ 生效与否直接可读，修 TZ 类问题时不用再推演 */
      tz:   Intl.DateTimeFormat().resolvedOptions().timeZone + ' | env TZ=' + (process.env.TZ || 'unset'),
      time: cnNow()
    }
  });
}));

/* 6.1 GET /api/colleges —— 查询院校（支持 keyword / region / level / sort / page / size） */
app.get('/api/colleges', safe((req, res) => {
  const r = queryColleges(req.query);
  ok(res, r.list, r.total, r.page, r.size);
}));

/* 6.2 GET /api/majors —— 查询专业（支持 keyword / category / page / size） */
app.get('/api/majors', safe((req, res) => {
  const r = queryMajors(req.query);
  ok(res, r.list, r.total, r.page, r.size);
}));

/* 6.3 以下接口供前端首屏「维表拉全量」用，让详情页/省份选择器也读真实数据库 */
app.get('/api/careers', safe((req, res) => {
  const keyword  = text(req.query.keyword);
  const category = text(req.query.category);

  const where = [];
  const args  = [];
  if (keyword) {
    where.push('(name LIKE ? OR category LIKE ? OR description LIKE ?)');
    const k = '%' + keyword + '%';
    args.push(k, k, k);
  }
  if (category) { where.push('category = ?'); args.push(category); }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS n FROM careers' + w).get(...args).n;
  const { page, size, offset } = paging(req.query);
  const list = db.prepare('SELECT * FROM careers' + w + ' ORDER BY demand DESC, id ASC LIMIT ? OFFSET ?')
                 .all(...args, size, offset);
  ok(res, list, total, page, size);
}));

app.get('/api/provinces', safe((req, res) => {
  const list = db.prepare('SELECT * FROM provinces ORDER BY seq ASC').all();
  ok(res, list, list.length, 1, list.length || 1);
}));

app.get('/api/news', safe((req, res) => {
  const list = db.prepare('SELECT * FROM news ORDER BY seq ASC').all();
  ok(res, list, list.length, 1, list.length || 1);
}));

/* 6.3.1 GET /api/groups —— 院校专业组（可按 collegeId 过滤；前端首屏拉全量） */
app.get('/api/groups', safe((req, res) => {
  if (!tableExists('college_major_groups')) return ok(res, [], 0, 1, 1);
  const collegeId = parseInt(req.query.collegeId, 10);

  const where = ['is_active = 1'];
  const args  = [];
  if (Number.isInteger(collegeId) && collegeId > 0) { where.push('college_id = ?'); args.push(collegeId); }

  const w = ' WHERE ' + where.join(' AND ');
  const total = db.prepare('SELECT COUNT(*) AS n FROM college_major_groups' + w).get(...args).n;
  const { page, size, offset } = paging(req.query);
  /* 排序纪律：院校 → 组内顺序 → 组代号。顺序稳定，分页才不会错位。 */
  const list = db.prepare(
    'SELECT * FROM college_major_groups' + w +
    ' ORDER BY college_id ASC, seq ASC, group_code ASC LIMIT ? OFFSET ?'
  ).all(...args, size, offset);

  ok(res, list.map(shapeGroup), total, page, size);
}));

/* 6.3.2 GET /api/admissions —— 历年录取分数线 / 位次（可按 collegeId、province、since 过滤） */
app.get('/api/admissions', safe((req, res) => {
  if (!tableExists('admission_histories')) return ok(res, [], 0, 1, 1);
  const collegeId = parseInt(req.query.collegeId, 10);
  const province  = text(req.query.province);
  const since     = parseInt(req.query.since, 10);

  const where = [];
  const args  = [];
  if (Number.isInteger(collegeId) && collegeId > 0) { where.push('college_id = ?'); args.push(collegeId); }
  if (province) { where.push('province = ?'); args.push(province); }
  if (Number.isInteger(since) && since > 1900) { where.push('year >= ?'); args.push(since); }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS n FROM admission_histories' + w).get(...args).n;
  const { page, size, offset } = paging(req.query);
  const list = db.prepare(
    'SELECT * FROM admission_histories' + w +
    ' ORDER BY college_id ASC, year ASC, province ASC LIMIT ? OFFSET ?'
  ).all(...args, size, offset);

  ok(res, list.map(shapeAdmission), total, page, size);
}));

/* 6.3.2b GET /api/admission-scores —— 录取分数表（院校×专业×年份）
   可按 collegeId、majorId、year 过滤；前端详情页首屏会整表拉全量后本地切片。 */
app.get('/api/admission-scores', safe((req, res) => {
  if (!tableExists('admission_scores')) {
    return ok(res, [], 0, 1, 1);
  }
  const collegeId = parseInt(req.query.collegeId, 10);
  const majorId   = parseInt(req.query.majorId, 10);
  const year      = parseInt(req.query.year, 10);

  const where = [];
  const args  = [];
  if (Number.isInteger(collegeId) && collegeId > 0) { where.push('college_id = ?'); args.push(collegeId); }
  if (Number.isInteger(majorId)   && majorId   > 0) { where.push('major_id = ?');   args.push(majorId); }
  if (Number.isInteger(year)      && year    > 1900) { where.push('year = ?');       args.push(year); }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS n FROM admission_scores' + w).get(...args).n;
  const { page, size, offset } = paging(req.query);
  /* 排序纪律：院校 → 专业 → 年份升序（取「最新一年」= 末位，口径与前端一致） */
  const list = db.prepare(
    'SELECT * FROM admission_scores' + w +
    ' ORDER BY college_id ASC, major_id ASC, year ASC LIMIT ? OFFSET ?'
  ).all(...args, size, offset);

  ok(res, list.map(shapeScore), total, page, size);
}));

/* 6.3.3 GET /api/users —— 考生列表（多用户切换器要用） */
app.get('/api/users', safe((req, res) => {
  if (!tableExists('users')) return ok(res, [], 0, 1, 1);
  const list = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  ok(res, list, list.length, 1, list.length || 1);
}));

/**
 * 6.3.4 POST /api/users —— 新增考生
 * 请求体：{ name: '张三', province: '河南', score: 620 }
 * 返回：  { code: 200, data: { saved: {...}, total: n } }
 */
app.post('/api/users', safe((req, res) => {
  const body  = req.body || {};
  const name  = text(body.name, 20);
  const prov  = text(body.province, 20);
  const score = parseInt(body.score, 10);

  if (!name) return fail(res, 400, '考生姓名不能为空');
  if (!Number.isInteger(score) || score < 0 || score > 750) {
    return fail(res, 400, '分数必须是 0 ~ 750 之间的整数');
  }
  /* 省份必须是真实存在的省份，避免前端传进来一个查不到批次的字符串 */
  if (prov && !db.prepare('SELECT 1 AS ok FROM provinces WHERE name = ?').get(prov)) {
    return fail(res, 400, '省份不存在：' + prov);
  }

  const info = db.prepare('INSERT INTO users (name, province, score, subject_type) VALUES (?,?,?,?)')
                 .run(name, prov, score, text(body.subjectType, 10) || '物理类');
  const saved = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log('[新增考生] ' + name + '（' + (prov || '未选省份') + ' / ' + score + ' 分）→ users.id=' + info.lastInsertRowid);
  res.json({ code: 200, data: { saved, total } });
}));

/**
 * 6.3.5 PUT /api/users/:id —— 更新某位考生的档案（分数 / 省份）
 * 请求体：{ score: 620, province: '河南' }（两个字段都可选，只更新传了的）
 * 用途：切换考生「切走」时把当前考生的分数与省份回写，
 *       这样切回来看到的是他自己最后的状态，而不是上一位考生的。
 */
app.put('/api/users/:id', safe((req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'id 必须是正整数');

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '考生不存在，id = ' + id);

  const body = req.body || {};
  const hasScore = body.score !== undefined && body.score !== null && body.score !== '';
  const hasProv  = body.province !== undefined && body.province !== null;

  if (hasScore) {
    const score = parseInt(body.score, 10);
    if (!Number.isInteger(score) || score < 0 || score > 750) {
      return fail(res, 400, '分数必须是 0 ~ 750 之间的整数');
    }
  }
  if (hasProv) {
    const prov = text(body.province, 20);
    /* 允许置空（表示还没选省份），但非空时必须是真实省份 */
    if (prov && !db.prepare('SELECT 1 AS ok FROM provinces WHERE name = ?').get(prov)) {
      return fail(res, 400, '省份不存在：' + prov);
    }
  }
  if (!hasScore && !hasProv) return fail(res, 400, '没有需要更新的字段（score / province）');

  const nextScore = hasScore ? parseInt(body.score, 10) : row.score;
  const nextProv  = hasProv ? text(body.province, 20) : row.province;

  db.prepare('UPDATE users SET score = ?, province = ? WHERE id = ?').run(nextScore, nextProv, id);
  const saved = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ code: 200, data: { saved } });
}));

/* 6.4 GET /api/volunteers —— 读回志愿表（这就是「刷新后数据还在」的来源）
   多用户：只读「当前考生」的那一份，各人互不干扰。 */
app.get('/api/volunteers', safe((req, res) => {
  const userId = uid(req);
  const rows = db.prepare('SELECT * FROM volunteers WHERE user_id = ? ORDER BY id ASC').all(userId);
  const list = rows.map(shapeVolunteer);
  ok(res, list, list.length, 1, list.length || 1);
}));

/**
 * 6.5 POST /api/upload —— 接收前端提交的数据，写入 SQLite
 * 请求体：{ kind: 'college' | 'major', refId: 数字, payload: 前端那个对象 }
 * 返回：  { code: 200, data: { saved: {...}, total: n } }
 */
function handleUpload(req, res) {
  const body = req.body || {};
  const kind = text(body.kind, 20);
  const refId = parseInt(body.refId, 10);
  const userId = uid(req);

  /* —— 考生必须真的存在，否则这条志愿会变成一个「孤儿行」—— */
  if (!db.prepare('SELECT 1 AS ok FROM users WHERE id = ?').get(userId)) {
    return fail(res, 404, '考生不存在，userId = ' + userId + '（请先 GET /api/users 取一个有效 id）');
  }

  /* —— 边界校验：绝不信任客户端 —— */
  if (kind !== 'college' && kind !== 'major') {
    return fail(res, 400, 'kind 只能是 college 或 major');
  }
  if (!Number.isInteger(refId) || refId <= 0) {
    return fail(res, 400, 'refId 必须是正整数');
  }
  const table = kind === 'college' ? 'colleges' : 'majors';
  const src = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(refId);
  if (!src) {
    return fail(res, 404, '要加入志愿表的' + (kind === 'college' ? '院校' : '专业') + '不存在，id = ' + refId);
  }

  /* —— 幂等：同一考生里重复提交同一项，不产生重复行 —— */
  const exists = db.prepare('SELECT * FROM volunteers WHERE user_id = ? AND kind = ? AND ref_id = ?')
                   .get(userId, kind, refId);
  if (exists) {
    const list = db.prepare('SELECT * FROM volunteers WHERE user_id = ? ORDER BY id ASC').all(userId).map(shapeVolunteer);
    return res.json({ code: 200, data: { saved: shapeVolunteer(exists), total: list.length, duplicated: true } });
  }

  /* —— 落库：以数据库里的真实字段为准，payload 只作为完整快照存一份 —— */
  let payloadStr = '{}';
  try { payloadStr = JSON.stringify(body.payload || {}).slice(0, 20000); } catch (e) { payloadStr = '{}'; }

  const info = db.prepare(
    'INSERT INTO volunteers (user_id, kind, ref_id, name, province, city, level, type, score, adjusted_score, payload)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    userId,
    kind,
    refId,
    String(src.name || ''),
    String(src.province || ''),
    String(src.city || ''),
    String(src.level || ''),
    String(src.type || ''),
    Number(src.score) || 0,
    Number((body.payload && body.payload.adjustedScore) || src.score) || 0,
    payloadStr
  );

  const saved = db.prepare('SELECT * FROM volunteers WHERE id = ?').get(Number(info.lastInsertRowid));
  const total = db.prepare('SELECT COUNT(*) AS n FROM volunteers WHERE user_id = ?').get(userId).n;
  console.log('[写入成功] 考生' + userId + ' · ' + kind + ' #' + refId + ' ' + src.name +
              ' → volunteers.id=' + info.lastInsertRowid);
  res.json({ code: 200, data: { saved: shapeVolunteer(saved), total } });
}
app.post('/api/upload', safe(handleUpload));
app.post('/api/volunteers', safe(handleUpload));   /* 同义别名，语义更直白 */

/* 6.6 DELETE /api/volunteers/:kind/:refId —— 把某一项移出「当前考生」的志愿表 */
app.delete('/api/volunteers/:kind/:refId', safe((req, res) => {
  const kind  = text(req.params.kind, 20);
  const refId = parseInt(req.params.refId, 10);
  const userId = uid(req);
  if (kind !== 'college' && kind !== 'major') return fail(res, 400, 'kind 只能是 college 或 major');
  if (!Number.isInteger(refId) || refId <= 0) return fail(res, 400, 'refId 必须是正整数');
  const info = db.prepare('DELETE FROM volunteers WHERE user_id = ? AND kind = ? AND ref_id = ?')
                 .run(userId, kind, refId);
  const total = db.prepare('SELECT COUNT(*) AS n FROM volunteers WHERE user_id = ?').get(userId).n;
  res.json({ code: 200, data: { removed: kind + '#' + refId, changes: info.changes, total } });
}));

/* 6.7 DELETE /api/volunteers/:id —— 按数据库行 id 移除 */
app.delete('/api/volunteers/:id', safe((req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'id 必须是正整数');
  const row = db.prepare('SELECT * FROM volunteers WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '志愿表里没有 id = ' + id + ' 的记录');
  db.prepare('DELETE FROM volunteers WHERE id = ?').run(id);
  const total = db.prepare('SELECT COUNT(*) AS n FROM volunteers WHERE user_id = ?').get(row.user_id).n;
  res.json({ code: 200, data: { deleted: id, total } });
}));

/* 6.8 前端页面 */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* 6.8.1 D 域（家庭协同）—— 只增式挂载：位于既有 /api 路由之后、catch-all 404 之前 */
app.use('/api', require('./routes-d'));

/* 6.9 未匹配的 /api/* 一律返回 JSON（不要返回 HTML，否则前端解析会莫名其妙失败） */
app.use('/api', (req, res) => fail(res, 404, '接口不存在：' + req.method + ' ' + req.originalUrl));

/* ===========================================================================
 * 7. 全局错误处理 —— 放在所有路由之后
 * ========================================================================= */
app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    time: new Date().toISOString(), reqId: req.id, level: 'error',
    message: err && err.message, stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4) : undefined
  }));
  if (res.headersSent) return next(err);
  fail(res, 500, '服务器内部错误，请查看命令行窗口的日志');
});

/* ===========================================================================
 * 8. 启动 + 优雅停机
 * ========================================================================= */
const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  =====================================================');
  console.log('   云端后端已启动 ✔');
  console.log('   监听地址：        http://' + HOST + ':' + PORT);
  console.log('   数据库文件：      ' + DB_FILE);
  console.log('   院校 ' + db.prepare('SELECT COUNT(*) AS n FROM colleges').get().n +
              ' 所 / 专业 ' + db.prepare('SELECT COUNT(*) AS n FROM majors').get().n +
              ' 个 / 考生 ' + db.prepare('SELECT COUNT(*) AS n FROM users').get().n +
              ' 位 / 志愿表 ' + db.prepare('SELECT COUNT(*) AS n FROM volunteers').get().n + ' 条');
  console.log('  =====================================================');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  [启动失败] 端口 ' + PORT + ' 已被占用（可能上次的服务还开着）。');
    console.error('  办法一：关掉之前那个进程，再重新启动本服务');
    console.error('  办法二：换个端口：  PORT=7861 node server.js');
    console.error('');
  } else {
    console.error('[启动失败] ' + err.message);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log('\n收到 ' + signal + '，正在关闭服务并释放数据库…');
  server.close(() => {
    try { db.close(); } catch (e) { /* 忽略 */ }
    console.log('已安全退出。');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
