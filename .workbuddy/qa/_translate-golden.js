'use strict';
/* ============================================================================
 * _translate-golden.js —— 换位翻译引擎「真·PG」golden 验收（端到端，含落库）
 * ---------------------------------------------------------------------------
 * 运行前提：进程环境变量 DATABASE_URL 指向已执行 06/07 迁移的 Postgres
 *   （本地 embedded-postgres 或 Supabase dev 均可）。脚本会：
 *   1) 用合成测试身份（TEST_UID）落 family_message，直接驱动
 *      services/careerTranslate 的 translateMessage / extractCareerSignal；
 *   2) 断言 translation_status='done'、translation_text 四段齐备 + 保真引用原话、
 *      translation_engine='rules@1.0.0'、translation_version 与 raw_version 一致；
 *   3) 断言 message_career_signal 落 1 条、axis_code 命中期望轴、引擎 rules@1.0.0；
 *   4) 红线样例 → state='flagged'、flag_reason 以 'sys:' 开头；
 *   5) 无关样例 → state='failed'（绝不伪造译文）；
 *   6) 跑完清理测试数据（DELETE family_message + message_career_signal）。
 * 这是 PRD §3.6.4 + §11.10 的「真机」验收入口；纯逻辑版见 _translate-golden-logic.js。
 * ========================================================================== */
const path = require('path');
const { Pool } = require('pg');
const ct = require(path.join(__dirname, '..', '..', 'services', 'careerTranslate'));

const TEST_UID = 990001;
const ROOM = 'golden-room-' + Date.now();
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[FATAL] 需要环境变量 DATABASE_URL（已执行 06/07 迁移的 Postgres）');
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); } }

const GOLDEN = [
  ['G1c', '学医我肯定读不下去，我宁愿学动画！', 'child_to_parent', 'student', 'A', '动画'],
  ['G1p', '必须学医，别的免谈！', 'parent_to_child', 'father', 'A', '学医'],
  ['G2c', '我就想做自媒体，这行你们不懂！', 'child_to_parent', 'student', 'D', '自媒体'],
  ['G2p', '这专业以后谁要你？', 'parent_to_child', 'father', 'A', '谁要你'],
  ['G3c', '你们安排的人生我不要！', 'child_to_parent', 'student', 'E', '安排'],
  ['G3p', '你就听我的，我不会害你。', 'parent_to_child', 'father', 'E', '听我的'],
  ['G4c', '我就想学艺术，钱少点我认。', 'child_to_parent', 'student', 'B', '钱少'],
  ['G4p', '谈理想能当饭吃？', 'parent_to_child', 'father', 'B', '理想'],
  ['G5c', '我想去上海做 AI，小城市没机会。', 'child_to_parent', 'student', 'C', '上海'],
  ['G5p', '跑那么远干嘛，离家近点多好。', 'parent_to_child', 'father', 'C', '离家近'],
  ['G6c', '考古/人工智能是新方向，你们只看老专业。', 'child_to_parent', 'student', 'D', '新方向'],
  ['G6p', '学这个能有啥出息，说出去都丢人。', 'parent_to_child', 'father', 'B', '出息'],
  ['G7c', '我可以不学医，但你们得听我说完。', 'child_to_parent', 'student', 'A', '听我说完'],
  ['G7p', '这事没得商量，别讨价还价。', 'parent_to_child', 'father', 'A', '没得商量'],
  ['G8c', '我查了几个月，你们那套早过时了。', 'child_to_parent', 'student', 'E', '查了几个月'],
  ['G8p', '我吃过的盐比你多，听我的没错。', 'parent_to_child', 'father', 'E', '吃过的盐']
];
const REDLINES = [
  ['R1 人身攻击', '白养你了，养你不如养条狗', 'father'],
  ['R2 威胁', '你不学医就别回这个家', 'father'],
  ['R3 心理危机', '活着没意思，不想活了', 'student'],
  ['R4 财务承诺', '我签字，给你五十万随便花', 'father'],
  ['R5 隐私违法', '我偷拍了别人的裸照', 'student'],
  ['R6 越界操作', '我替你篡改志愿', 'father']
];
const IRRELEVANT = [
  ['天气', '今天天气真不错，想去公园走走。', 'student'],
  ['致谢', '谢谢你的帮助', 'father']
];

async function insertMsg(raw, direction, role) {
  const r = await pool.query(
    `INSERT INTO public.family_message (user_id, room_id, sender_role, direction, raw_text, raw_version)
     VALUES ($1,$2,$3,$4,$5,1) RETURNING id, raw_version`,
    [TEST_UID, ROOM, role, direction, raw]
  );
  return r.rows[0];
}
function deriveDir(role) { return role === 'student' ? 'child_to_parent' : 'parent_to_child'; }

(async () => {
  const seenAxes = new Set();
  try {
    for (const [label, raw, dir, role, expAxis, kw] of GOLDEN) {
      const msg = await insertMsg(raw, dir, role);
      const res = await ct.translateMessage({ id: msg.id, raw_text: raw, raw_version: msg.raw_version, direction: dir });
      ok(res.state === 'done', `${label} translateMessage 应 done，实际 ${res.state}`);
      const row = await pool.query('SELECT * FROM public.family_message WHERE id=$1', [msg.id]);
      const r = row.rows[0];
      ok(r.translation_status === 'done', `${label} DB translation_status 应 done`);
      /* ★ 断言改为「四段齐备且无内部脚手架前缀」——旧断言写死 'S1 承接：'/'S4 提议：'，
       *   而那两个前缀正是要删掉的脚手架，不改断言会让 golden 永远红。 */
      const transTxt = String(r.translation_text || '');
      const parts = transTxt.split('\n').filter(s => s.trim() !== '');
      ok(parts.length === 4, `${label} DB 译文应为四段，实际 ${parts.length} 段`);
      ok(!/S[1-4]\s*(承接|感受|需要|提议)[:：]/.test(transTxt), `${label} DB 译文不得含内部脚手架前缀`);
      ok(r.translation_text && r.translation_text.includes(kw), `${label} DB 译文应引用原话核心「${kw}」`);
      ok(r.translation_engine === 'rules@1.0.0', `${label} translation_engine 应 rules@1.0.0`);
      ok(Number(r.translation_version) === Number(r.raw_version), `${label} translation_version 应 === raw_version`);

      const sig = await ct.extractCareerSignal({ id: msg.id, raw_text: raw, raw_version: msg.raw_version, direction: dir });
      ok(sig.signals && sig.signals.length === 1, `${label} extractCareerSignal 应产出 1 条`);
      if (sig.signals && sig.signals.length) {
        ok(sig.signals[0].axis_code === expAxis, `${label} 信号轴应 ${expAxis}，实际 ${sig.signals[0].axis_code}`);
        ok(sig.signals[0].extractor_engine === 'rules@1.0.0', `${label} 信号引擎应 rules@1.0.0`);
        seenAxes.add(sig.signals[0].axis_code);
      }
    }
    ['A', 'B', 'C', 'D', 'E'].forEach(ax => ok(seenAxes.has(ax), `冲突轴 ${ax} 至少 1 组 golden 覆盖`));

    for (const [label, raw, role] of REDLINES) {
      const dir = deriveDir(role);
      const msg = await insertMsg(raw, dir, role);
      const res = await ct.translateMessage({ id: msg.id, raw_text: raw, raw_version: msg.raw_version, direction: dir });
      ok(res.state === 'flagged', `${label} 应 flagged，实际 ${res.state}`);
      const row = await pool.query('SELECT flag_reason, is_flagged, translation_status FROM public.family_message WHERE id=$1', [msg.id]);
      const r = row.rows[0];
      ok(r.is_flagged === true, `${label} is_flagged 应 true`);
      ok(r.flag_reason && r.flag_reason.startsWith('sys:'), `${label} flag_reason 应以 sys: 开头，实际 ${r.flag_reason}`);
      ok(r.translation_status === 'flagged', `${label} translation_status 应 flagged`);
      ok(r.flag_reason === null || /sys:/.test(r.flag_reason), `${label} 红线不得落译文`);
    }

    for (const [label, raw, role] of IRRELEVANT) {
      const dir = deriveDir(role);
      const msg = await insertMsg(raw, dir, role);
      const res = await ct.translateMessage({ id: msg.id, raw_text: raw, raw_version: msg.raw_version, direction: dir });
      ok(res.state === 'failed', `${label} 无关样例应 failed，实际 ${res.state}`);
      const row = await pool.query('SELECT translation_status, translation_text FROM public.family_message WHERE id=$1', [msg.id]);
      const r = row.rows[0];
      ok(r.translation_status === 'failed', `${label} translation_status 应 failed`);
      ok(r.translation_text === null, `${label} failed 译文必须 NULL（绝不原话直发）`);
    }
  } catch (e) {
    fail++; fails.push('EXCEPTION: ' + (e && e.message));
  } finally {
    // 清理测试数据
    try {
      await pool.query('DELETE FROM public.message_career_signal WHERE message_id IN (SELECT id FROM public.family_message WHERE user_id=$1)', [TEST_UID]);
      await pool.query('DELETE FROM public.family_message WHERE user_id=$1', [TEST_UID]);
    } catch (e) { /* 忽略清理错误 */ }
    await pool.end();
  }

  console.log('=== 换位翻译引擎 golden（真 PG 端到端）===');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail) { console.log('FAILED:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  else { console.log('ALL GREEN [5 axes: ' + [...seenAxes].sort().join(',') + ']'); }
})();
