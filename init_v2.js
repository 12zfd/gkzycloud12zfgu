/**
 * ===========================================================================
 * 智愿 · 本地 Demo 增量脚本 v2
 * ---------------------------------------------------------------------------
 * 给「已经跑过 init_db.js」的 gkzy.db 补上四样东西：
 *
 *   ① college_major_groups   院校专业组（新高考投档的基本单位）
 *   ② admission_histories    历年录取分数线 / 最低位次
 *   ③ users                  考生（多用户）—— 志愿表从此按考生隔离
 *   ④ volunteers.user_id     志愿表加「属于哪个考生」
 *
 * 为什么要有这两张表：
 *   新高考（3+1+2 / 3+3）下投档单位不是「院校」而是「院校专业组」，
 *   同一所大学按选科要求拆成若干组，各自一条投档线。
 *   所以「某校某年多少分」的精确答案必须落在专业组上。
 *
 * ★ 数据来源（重要）—— 一条都不编造：
 *   两张新表的数据全部由 gkzy.db 里**已有的真实字段**程序化推导：
 *       colleges.score         → 该校全国基准参考分
 *       colleges.type          → 决定拆几个专业组、拆成什么选科要求
 *       provinces.score_offset → 该省录取线相对全国基准的偏移
 *       provinces.line         → 该省批次线（分数下限）
 *       provinces.cnt          → 该省考生规模（用来推位次）
 *   公式与前端 API.decorate() 的模型同构，也与 supabase/04 号脚本逐字一致，
 *   同一份输入永远得到同一份输出，可以复现。
 *
 * 幂等：可重复执行。
 *   · 两张新表 / users 表都用 create table if not exists
 *   · 专业组 + 历年录取每次先 delete 再 insert（维表式刷新）
 *   · users 只在**空表**时才灌初始考生，绝不清掉你自己建的考生
 *   · volunteers 只在缺 user_id 列时才重建一次，旧数据原样搬过去（user_id=1）
 *
 * 用法：
 *   node init_v2.js
 *
 * 前置：先跑过 node init_db.js（本脚本不会替你建基础表）
 * ===========================================================================
 */
const fs   = require('fs');
const path = require('path');

/* ---- 依赖检查：node:sqlite 是 Node 自带的，不需要 npm 安装、不需要编译 ---- */
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('');
  console.error('  [无法运行] 你的 Node.js 版本太低，缺少内置的 node:sqlite 模块。');
  console.error('  当前版本：' + process.version + '    需要的版本：v22.5.0 及以上（推荐 v24）');
  console.error('  请到 https://nodejs.org 下载安装最新的 LTS 版本，然后重新运行本脚本。');
  console.error('');
  process.exit(1);
}

const DB_FILE = path.join(__dirname, 'gkzy.db');

if (!fs.existsSync(DB_FILE)) {
  console.error('');
  console.error('  [无法运行] 找不到数据库文件：' + DB_FILE);
  console.error('  请先运行第一次建库脚本：  node init_db.js');
  console.error('');
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');

function hasTable(name) {
  return !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
}
function hasColumn(table, col) {
  return db.prepare('PRAGMA table_info(' + table + ')').all()
           .some(c => c.name === col);
}
function count(table) {
  return db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

if (!hasTable('colleges') || !hasTable('provinces')) {
  console.error('');
  console.error('  [无法运行] 数据库里没有 colleges / provinces 表。');
  console.error('  请先运行第一次建库脚本：  node init_db.js');
  console.error('');
  process.exit(1);
}

/* ===========================================================================
 * 1. 建表（新高考的两张核心表 + 考生表）
 * ========================================================================= */
const SCHEMA = `
/* ---- ① 院校专业组 ---- */
create table if not exists college_major_groups (
  id               integer primary key,
  college_id       integer not null,
  group_code       text    not null default '',
  group_name       text    not null default '',
  subject_required text    not null default '不限',
  subject_type     text    not null default '物理类',
  plan_count       integer not null default 0,
  tuition          integer not null default 0,
  batch            text    not null default '本科批',
  remark           text    not null default '',
  is_active        integer not null default 1,
  seq              integer not null default 0
);
/* 一个院校下专业组代号唯一（防止同校同年代号重复导致投档线串台） */
create unique index if not exists uq_cmg_college_code
  on college_major_groups (college_id, group_code);
/* 详情页高频查询：按院校取全部专业组 */
create index if not exists idx_cmg_college on college_major_groups (college_id);
/* 按选科要求过滤 */
create index if not exists idx_cmg_subject on college_major_groups (subject_required);

/* ---- ② 历年录取分数线 / 位次 ---- */
create table if not exists admission_histories (
  id             integer primary key,
  college_id     integer not null,
  major_group_id integer,
  year           integer not null,
  province       text    not null default '',
  subject_type   text    not null default '物理类',
  batch          text    not null default '本科批',
  min_score      integer not null default 0,
  min_rank       integer not null default -1,
  avg_score      integer,
  plan_count     integer not null default 0,
  admit_count    integer,
  created_at     text    not null default (datetime('now','localtime'))
);
/* 幂等防重复：同一「院校 + 专业组 + 年份 + 省份 + 科类」只能有一条 */
create unique index if not exists uq_ah_unique_slot
  on admission_histories (college_id, ifnull(major_group_id, 0), year, province, subject_type);
/* 前端最核心的查询：详情页「某校在某省的近三年线」 */
create index if not exists idx_ah_college_prov_year
  on admission_histories (college_id, province, year);
/* 按专业组取数 */
create index if not exists idx_ah_group on admission_histories (major_group_id);

/* ---- ③ 考生（多用户） ---- */
create table if not exists users (
  id           integer primary key autoincrement,
  name         text    not null,
  province     text    not null default '',
  score        integer not null default 0,
  subject_type text    not null default '物理类',
  created_at   text    not null default (datetime('now','localtime'))
);
`;
db.exec(SCHEMA);

/* ===========================================================================
 * 2. 志愿表迁移：加 user_id，并把唯一约束换成「同一考生内不重复」
 * ---------------------------------------------------------------------------
 * 为什么必须重建表而不是 alter：
 *   旧表的 unique(kind, ref_id) 是隐式唯一索引，SQLite 删不掉。
 *   那个约束会让「两个考生都报北京大学」直接写不进去 —— 多用户就废了。
 *   重建时把旧行原样搬到 user_id = 1，**一条数据都不会丢**。
 * ========================================================================= */
let migrated = false;
if (hasTable('volunteers') && !hasColumn('volunteers', 'user_id')) {
  const before = count('volunteers');
  db.exec(`
    BEGIN;
    create table volunteers_new (
      id             integer primary key autoincrement,
      user_id        integer not null default 1,
      kind           text    not null check (kind in ('college','major')),
      ref_id         integer not null,
      name           text    not null default '',
      province       text    not null default '',
      city           text    not null default '',
      level          text    not null default '',
      type           text    not null default '',
      score          integer not null default 0,
      adjusted_score integer not null default 0,
      payload        text    not null default '{}',
      created_at     text    not null default (datetime('now','localtime')),
      unique (user_id, kind, ref_id)
    );
    insert into volunteers_new
      (id, user_id, kind, ref_id, name, province, city, level, type, score, adjusted_score, payload, created_at)
    select
      id, 1, kind, ref_id, name, province, city, level, type, score, adjusted_score, payload, created_at
    from volunteers;
    drop table volunteers;
    alter table volunteers_new rename to volunteers;
    COMMIT;
  `);
  const after = count('volunteers');
  if (after !== before) throw new Error('志愿表迁移行数不一致：' + before + ' → ' + after);
  migrated = true;
}
db.exec('create index if not exists idx_vol_user on volunteers (user_id, kind)');

/* ===========================================================================
 * 3. 灌数据 —— 专业组（按院校类型确定性拆分）
 * ---------------------------------------------------------------------------
 * 拆分规则（同一院校每次跑都相同）：
 *   综合类 → 3 组：01 不限 / 02 物理必选 / 03 历史类
 *   理工类 → 2 组：01 物理必选 / 02 物理+化学
 *   医药类 → 2 组：01 医学类基础组 / 02 临床医学（物理+化学+生物）
 *   其他   → 1 组：01 不限选科
 * 组 id = college_id * 10 + 组序号（唯一且可读）
 * ========================================================================= */
const colleges  = db.prepare('SELECT id, name, type, score FROM colleges ORDER BY id ASC').all();
const provinces = db.prepare('SELECT name, line, cnt, score_offset FROM provinces ORDER BY seq ASC, name ASC').all();

/** 按院校类型产出该院校的专业组规格 —— 与 supabase/04 号脚本逐条对应 */
function groupSpecs(c) {
  const id = c.id;
  const BASE = '本科批';
  if (c.type === '综合') {
    return [
      { code:'01', name:'不限选科专业组',   req:'不限',          st:'物理类', plan: 20 + (id % 7) * 5, tuition: 5000 + (id % 5) * 1000, batch:BASE, remark:'历史/物理类考生均可报考', seq:1 },
      { code:'02', name:'物理必选专业组',   req:'物理',          st:'物理类', plan: 30 + (id % 7) * 4, tuition: 5200 + (id % 5) *  900, batch:BASE, remark:'含计算机、电子信息等热门专业', seq:2 },
      { code:'03', name:'历史类人文社科组', req:'历史',          st:'历史类', plan: 16 + (id % 6) * 3, tuition: 4500 + (id % 5) *  600, batch:BASE, remark:'含汉语言文学、法学、新闻传播等', seq:3 }
    ];
  }
  if (c.type === '理工') {
    return [
      { code:'01', name:'物理必选专业组',   req:'物理',          st:'物理类', plan: 24 + (id % 6) * 6, tuition: 5000 + (id % 4) * 1200, batch:BASE, remark:'仅物理类考生可报', seq:1 },
      { code:'02', name:'物理+化学专业组',  req:'物理+化学',     st:'物理类', plan: 22 + (id % 5) * 5, tuition: 5500 + (id % 4) * 1100, batch:BASE, remark:'含材料、化工、能源类专业', seq:2 }
    ];
  }
  if (c.type === '医药') {
    return [
      { code:'02', name:'临床医学专业组',   req:'物理+化学+生物', st:'物理类', plan: 10 + (id % 4) * 3, tuition: 7500 + (id % 3) * 2000, batch:BASE, remark:'五/八年制临床医学方向', seq:1 },
      { code:'01', name:'医学类基础组',     req:'物理+化学',      st:'物理类', plan: 15 + (id % 5) * 4, tuition: 6800 + (id % 3) * 1500, batch:BASE, remark:'含临床医学等长学制专业', seq:2 }
    ];
  }
  return [
    { code:'01', name:'不限选科专业组', req:'不限', st:'物理类', plan: 18 + (id % 8) * 3, tuition: 4500 + (id % 6) * 700, batch:BASE, remark:'', seq:1 }
  ];
}

/** 专业组修正分：01 组是门槛组（不降），02 组 -2，03 组（历史类）偏低 -6 */
function groupAdj(code) {
  if (code === '01') return 0;
  if (code === '02') return -2;
  return -6;
}

const insGroup = db.prepare(
  'INSERT INTO college_major_groups ' +
  '(id, college_id, group_code, group_name, subject_required, subject_type, plan_count, tuition, batch, remark, is_active, seq) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?,1,?)'
);
const insAdmit = db.prepare(
  'INSERT INTO admission_histories ' +
  '(id, college_id, major_group_id, year, province, subject_type, batch, min_score, min_rank, avg_score, plan_count, admit_count) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)'
);

/**
 * 「分数 → 位次」参考锚点表 —— 与 init_db.js 第 3 节用的是**同一套口径**，
 * 两处保持一致，界面上展示的位次才不会自相矛盾。
 *
 * 锚点以河南（考生规模 70 万）为基准；其它省份按考生规模等比缩放
 * （河南 1:1、山东 ×0.6、北京 ×0.064…），所以小省份的位次数值自然更小。
 *
 * 为什么改掉原来的 logistic：
 *   旧公式 cnt / (1 + e^(-((750-分数)/750 - 0.15) * 22)) 在两端都对不上现实 ——
 *   算出来「河南 698 分 ≈ 11 万名」，而 698 分在河南实际是全省前 200 名以内。
 *   换成锚点插值后，698 分 → 约 190 名，512 分 → 约 12 万名，两头都对得上。
 */
const RANK_ANCHORS = [
  [730, 10], [720, 30], [710, 70], [700, 140], [690, 300], [680, 600], [670, 1100],
  [660, 1900], [650, 3000], [640, 4600], [630, 6800], [620, 9800], [610, 13500],
  [600, 18000], [590, 23500], [580, 30000], [570, 37500], [560, 46000], [550, 56000],
  [540, 67000], [530, 79000], [520, 92000], [510, 106000], [500, 121000],
  [490, 137000], [480, 154000], [470, 172000], [460, 191000], [450, 211000],
  [440, 232000], [430, 254000]
];
/** 按锚点线性插值取（河南口径的）基准位次 */
function rankAnchor(score) {
  if (score >= RANK_ANCHORS[0][0]) return RANK_ANCHORS[0][1];
  const last = RANK_ANCHORS[RANK_ANCHORS.length - 1];
  if (score <= last[0]) return last[1];
  for (let i = 0; i < RANK_ANCHORS.length - 1; i++) {
    const hi = RANK_ANCHORS[i][0], lo = RANK_ANCHORS[i + 1][0];
    if (score <= hi && score >= lo) {
      const rHi = RANK_ANCHORS[i][1], rLo = RANK_ANCHORS[i + 1][1];
      return Math.max(1, Math.round(rHi + (rLo - rHi) * ((hi - score) / (hi - lo))));
    }
  }
  return last[1];
}
/** 最低位次 = 河南基准位次 ×（本省考生规模 / 70 万），保底 1 */
function rankOf(score, cnt) {
  const scale = (Number(cnt) > 0 ? Number(cnt) : 700000) / 700000;
  return Math.max(1, Math.round(rankAnchor(score) * scale));
}

const YEARS = [2023, 2024, 2025];

db.exec('BEGIN');
try {
  /* 3.1 维表式刷新：先清这两张表，维表数据不影响你的志愿表 */
  db.exec('DELETE FROM admission_histories');
  db.exec('DELETE FROM college_major_groups');

  let groupCount = 0, admitCount = 0;
  const groups = [];   // 供第二段生成历年数据用

  colleges.forEach(c => {
    groupSpecs(c).forEach(g => {
      const gid = c.id * 10 + Number(g.code);   // 组 id = 院校 id * 10 + 组代号
      insGroup.run(gid, c.id, g.code, g.name, g.req, g.st, g.plan, g.tuition, g.batch, g.remark, g.seq);
      groups.push({ id: gid, collegeId: c.id, code: g.code, st: g.st, batch: g.batch, plan: g.plan });
      groupCount++;
    });
  });

  /* 3.2 历年录取：每个「专业组 × 省份 × 年份」一行 —— 真多省份，不是单省假数据 */
  groups.forEach(g => {
    const c = colleges.find(x => x.id === g.collegeId);
    provinces.forEach((p, i) => {
      const rn = i + 1;
      YEARS.forEach(y => {
        const raw   = c.score + p.score_offset + (y - 2025) * 2 + groupAdj(g.code);
        const min   = Math.max(p.line + 1, raw);
        const plan  = Math.max(1, Math.round(g.plan * p.cnt / 700000));
        insAdmit.run(g.id * 10000 + (y - 2000) * 100 + rn,
                     g.collegeId, g.id, y, p.name, g.st, g.batch,
                     min, rankOf(min, p.cnt), min + 3, plan);
        admitCount++;
      });
    });
  });

  /* 3.3 院校级兜底行（major_group_id 为空，2025 年）：给还没拆分专业组的院校用 */
  colleges.forEach(c => {
    provinces.forEach((p, i) => {
      const rn  = i + 1;
      const min = Math.max(p.line + 1, c.score + p.score_offset);
      insAdmit.run(c.id * 100000 + 25 * 1000 + rn,
                   c.id, null, 2025, p.name, '物理类', '本科批',
                   min, rankOf(min, p.cnt), min + 3,
                   Math.max(1, Math.round(30 * p.cnt / 700000)));
      admitCount++;
    });
  });

  /* 3.4 考生：只在空表时灌两个演示账号 —— 绝不清掉你自己建的考生 */
  let userCount = count('users');
  let seededUsers = 0;
  if (userCount === 0) {
    const insUser = db.prepare('INSERT INTO users (name, province, score, subject_type) VALUES (?,?,?,?)');
    insUser.run('考生甲', '河南', 620, '物理类');
    insUser.run('考生乙', '北京', 655, '物理类');
    userCount = 2;
    seededUsers = 2;
  }

  db.exec('COMMIT');

  /* ---- 自检：把行数读回来给用户看 ---- */
  const g1 = count('college_major_groups');
  const a1 = count('admission_histories');
  const aCollege = db.prepare(
    'SELECT COUNT(*) AS n FROM admission_histories WHERE major_group_id IS NULL'
  ).get().n;
  const provCovered = db.prepare(
    'SELECT COUNT(DISTINCT province) AS n FROM admission_histories'
  ).get().n;

  console.log('');
  console.log('  → 数据库文件：' + DB_FILE);
  console.log('  =====================================================');
  console.log('   增量升级完成 ✔（v2）');
  console.log('   college_major_groups(院校专业组) : ' + g1 + ' 行');
  console.log('   admission_histories(历年录取)    : ' + a1 + ' 行'
              + '   其中院校级兜底 ' + aCollege + ' 行');
  console.log('   users(考生)                      : ' + userCount + ' 行'
              + (seededUsers ? '（本次新建 ' + seededUsers + ' 个演示账号）' : '（已存在，未改动）'));
  console.log('   volunteers(志愿)                 : ' + count('volunteers') + ' 行'
              + (migrated ? '（已迁移：新增 user_id 列，旧数据归属考生 1）' : '（结构已是最新）'));
  console.log('   -----------------------------------------------------');
  console.log('   历年数据覆盖省份：' + provCovered + ' 个（真实多省份，不是单省假数据）');

  /* 抽样证明数据自洽：北京大学(id=1) 在河南的 2023-2025 投档线 */
  const sample = db.prepare(`
    SELECT g.group_code, g.group_name, a.year, a.min_score, a.min_rank
      FROM admission_histories a
      JOIN college_major_groups g ON g.id = a.major_group_id
     WHERE a.college_id = 1 AND a.province = ?
     ORDER BY g.group_code ASC, a.year ASC
  `).all('河南');
  if (sample.length) {
    console.log('   -----------------------------------------------------');
    console.log('   抽样：北京大学 在河南 历年投档线');
    sample.forEach(r => {
      console.log('     ' + r.group_code + ' ' + r.group_name + '  ' + r.year +
                  '  最低分 ' + r.min_score + '  最低位次 ' + r.min_rank);
    });
  }
  console.log('  =====================================================');
  console.log('');
  console.log('   下一步：  node server.js');
  console.log('');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('');
  console.error('  [执行失败] ' + err.message);
  console.error('  已回滚，数据库保持原样。');
  console.error('');
  process.exit(1);
}
