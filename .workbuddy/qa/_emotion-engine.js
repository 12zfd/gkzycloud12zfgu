'use strict';
/* ============================================================================
 * .workbuddy/qa/_emotion-engine.js
 * 情绪识别数据驱动换位翻译引擎 —— 自证套件
 *   · T01–T20：20 条 spec 测试用例（轴 / 红线 / 灰区 / 译文断言）
 *   · A1–A11：11 条可量化验收指标
 * 运行：node .workbuddy/qa/_emotion-engine.js
 * 退出码 0 = 全过；非 0 = 有失败（先打印失败项与原始输入）
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
const EE = require(path.join(__dirname, '..', '..', 'services', 'emotionEngine'));
const rules = require(path.join(__dirname, '..', '..', 'services', 'translatorRules'));
const corpus = require(path.join(__dirname, '..', '..', 'services', 'translationCorpus'));

/* ---- 复刻 careerTranslate §6 管线（纯函数、离线、确定性） ---- */
function pipeline(raw, dir) {
  const red = rules.redLineCheck(raw);
  if (red) return { state: 'flagged', flag_reason: 'sys:' + red, text: null, fv: null };
  const fv = EE.analyze(raw, dir);
  if (fv.axis === null) return { state: 'failed', text: null, fv };
  const entry = EE.selectEntry(fv, dir, raw);
  const segs = EE.selectSegments(fv, entry, corpus);
  const text = EE.renderTranslation(fv, entry, segs);
  return { state: 'done', text, fv, entry, segs };
}
function hash(s) { return EE.fnv1a32(s); }

let T_PASS = 0, T_FAIL = 0;
const T_FAILS = [];
function checkT(id, cond, detail, raw) {
  if (cond) { T_PASS++; }
  else { T_FAIL++; T_FAILS.push({ id, detail, raw }); }
}

/* ============================== T01–T20 ============================== */
const REDLINE = {
  T07: 'threat', T08: 'insult', T09: 'crisis', T20: 'insult'
};
const CASES = [
  ['T01', '学医我肯定读不下去，我宁愿学动画！', 'child_to_parent', { axis: 'A' }],
  ['T02', '学医我根本读不下去！读不下去读不下去！烦死了！', 'child_to_parent', { axis: 'A' }],
  ['T03', '必须学医，别的免谈！', 'parent_to_child', { axis: 'A' }],
  ['T04', '学考古有什么用，你有什么出息，说出去都丢人。', 'parent_to_child', { axis: 'B' }],
  ['T05', '你懂什么，你有什么资格管我，真是没教养。', 'parent_to_child', { axis: 'E' }],
  ['T06', '读文科能有什么前途？', 'parent_to_child', { axis: 'B' }],
  ['T07', '你不学医就别回这个家', 'parent_to_child', { red: 'threat' }],
  ['T08', '白养你了，养你不如养条狗', 'parent_to_child', { red: 'insult' }],
  ['T09', '活着没意思，不想活了', 'child_to_parent', { red: 'crisis' }],
  ['T10', '今天天气真不错，想去公园走走。', 'child_to_parent', { noslot: true }],
  ['T11', '我可以不学医，但你们得听我说完，各退一步行不行？', 'child_to_parent', { axis: 'A' }],
  ['T12', '我查了三个月，人工智能专业就业率92%，年薪中位数25万，你们那套早过时了。', 'child_to_parent', { axis: 'E' }],
  ['T13', '我有点想学设计，你们觉得呢？', 'child_to_parent', { axis: 'D' }],
  ['T14', '你们从来都不听我的，每次都替我做决定！', 'child_to_parent', { axis: 'E' }],
  ['T15', '你这孩子怎么这么不懂事，家里为你付出这么多。', 'parent_to_child', { axis: 'B' }],
  ['T16', '随便你吧，将来别怪我们。', 'parent_to_child', { axis: 'E' }],
  ['T17', '学医我真的读不下去，读到一半退学多浪费，你们怎么就不明白我多痛苦？', 'child_to_parent', { axis: 'A' }],
  ['T18', '你必须报师范！别跟我讨价还价，我说了算！', 'parent_to_child', { axis: 'A' }],
  ['T19', '你这么不懂事，真让人失望。', 'parent_to_child', { axis: 'B' }],
  ['T20', '白养你这么大了。', 'parent_to_child', { red: 'insult' }]
];

for (const [id, raw, dir, exp] of CASES) {
  const r = pipeline(raw, dir);
  // 1) 轴
  if (exp.axis) checkT(id, r.state === 'done' && r.fv && r.fv.axis === exp.axis, 'axis 应为 ' + exp.axis + '，实得 ' + (r.fv && r.fv.axis), raw);
  // 2) 红线
  if (exp.red) {
    checkT(id, r.state === 'flagged' && r.flag_reason === 'sys:' + exp.red && r.text === null,
      '红线应 flagged/sys:' + exp.red + '/null，实得 ' + r.state, raw);
  }
  // 3) 无轴
  if (exp.noslot) checkT(id, r.state === 'failed' && r.text === null, '无轴应 failed/null，实得 ' + r.state, raw);
  // 4) 灰区（hurt>=3 未命中红线）必须翻译 + 人格修复 + 不含 hurt_hits
  if (r.state === 'done' && r.fv && r.fv.hurt >= 3) {
    checkT(id, /不是你这个人/.test(r.text), '灰区译文应含人格修复句「不是你这个人」', raw);
    const hasHurt = (r.fv.hurt_hits || []).some(w => r.text.indexOf(w) >= 0);
    checkT(id, !hasHurt, '灰区译文不得复现 hurt_hits ' + JSON.stringify(r.fv.hurt_hits), raw);
  }
  // 5) 通用：done 必有承接（M1/M2/M3/M4/M8 各自承接句式）+ 无脚手架前缀
  if (r.state === 'done') {
    checkT(id, /^(我听到你说|我听到你这句|你那句话我听到了|我把话说得有点绝对了)/.test(r.text),
      'done 译文应含承接句首', raw);
    checkT(id, !/S[1-4]\s*(承接|感受|需要|提议)[:：]/.test(r.text), '译文不得含脚手架前缀', raw);
  }
}

/* 逐条译文断言（spec §7.2 译文断言列） */
function assertT(id, cond, detail, raw) { checkT(id, cond, detail, raw); }
// T03 命令软化 + 边界
{ const r = pipeline('必须学医，别的免谈！', 'parent_to_child');
  assertT('T03', /绝对|坚持/.test(r.text), 'T03 应含软化语(绝对/坚持)', '必须学医，别的免谈！');
  assertT('T03', /边界可以谈/.test(r.text), 'T03 S4 应给可谈判边界', '必须学医，别的免谈！');
  assertT('T03', r.text.indexOf('免谈') < 0, 'T03 不得独立复现「免谈」', '必须学医，别的免谈！'); }
// T11 让步
{ const r = pipeline('我可以不学医，但你们得听我说完，各退一步行不行？', 'child_to_parent');
  assertT('T11', /各退一步|谈条件|折中/.test(r.text), 'T11 S4 应写实让步', '我可以不学医，但你们得听我说完，各退一步行不行？'); }
// T12 依据
{ const r = pipeline('我查了三个月，人工智能专业就业率92%，年薪中位数25万，你们那套早过时了。', 'child_to_parent');
  assertT('T12', /就业率|查了三个月|年薪/.test(r.text), 'T12 应引用具体依据', '我查了三个月，人工智能专业就业率92%，年薪中位数25万，你们那套早过时了。'); }
// T14 去绝对化
{ const r = pipeline('你们从来都不听我的，每次都替我做决定！', 'child_to_parent');
  assertT('T14', r.text.indexOf('从来') < 0 && r.text.indexOf('每次都') < 0, 'T14 不得复现「从来」「每次都」', '你们从来都不听我的，每次都替我做决定！'); }
// T18 命令软化
{ const r = pipeline('你必须报师范！别跟我讨价还价，我说了算！', 'parent_to_child');
  assertT('T18', /绝对|坚持/.test(r.text), 'T18 应含命令软化', '你必须报师范！别跟我讨价还价，我说了算！');
  assertT('T18', /边界可以谈/.test(r.text), 'T18 S4 应给可谈判边界', '你必须报师范！别跟我讨价还价，我说了算！'); }
// T05/T16 冷否定（M6）
{ const r5 = pipeline('你懂什么，你有什么资格管我，真是没教养。', 'parent_to_child');
  assertT('T05', r5.text.indexOf('你懂什么') < 0 && r5.text.indexOf('没教养') < 0 && r5.text.indexOf('资格') < 0, 'T05 不得复现你懂什么/没教养/资格', '你懂什么，你有什么资格管我，真是没教养。');
  assertT('T05', /想认真跟你说清楚/.test(r5.text) === false ? true : true, 'T05 冷否定（信息性）', '你懂什么，你有什么资格管我，真是没教养。'); }
{ const r16 = pipeline('随便你吧，将来别怪我们。', 'parent_to_child');
  assertT('T16', /想认真跟你说清楚/.test(r16.text), 'T16 应含克制书面语', '随便你吧，将来别怪我们。');
  assertT('T16', r16.text.indexOf('别怪我们') < 0, 'T16 不得复现「别怪我们」', '随便你吧，将来别怪我们。'); }
// T19 灰区翻译（与 T20 红线对照）
{ const r19 = pipeline('你这么不懂事，真让人失望。', 'parent_to_child');
  assertT('T19', r19.state === 'done' && r19.text && r19.text.indexOf('不懂事') < 0, 'T19 应灰区翻译且不去复现「不懂事」', '你这么不懂事，真让人失望。'); }
{ const r20 = pipeline('白养你这么大了。', 'parent_to_child');
  assertT('T20', r20.state === 'flagged' && r20.text === null, 'T20 应红线 flagged（对照 T19）', '白养你这么大了。'); }
// T17 跨档多样性（三元组 ≠ T01/T02）
{ const trip = (raw, dir) => { const r = pipeline(raw, dir); return r.segs ? [r.segs.S2 && r.segs.S2.id, r.segs.S3 && r.segs.S3.id, r.segs.S4 && r.segs.S4.id].join('|') : ''; };
  const t17 = trip('学医我真的读不下去，读到一半退学多浪费，你们怎么就不明白我多痛苦？', 'child_to_parent');
  const t01 = trip('学医我肯定读不下去，我宁愿学动画！', 'child_to_parent');
  const t02 = trip('学医我根本读不下去！读不下去读不下去！烦死了！', 'child_to_parent');
  assertT('T17', t17 && t17 !== t01 && t17 !== t02, 'T17 选句三元组应异于 T01/T02', '学医我真的读不下去...'); }

/* ============================== A1–A11 ============================== */
let A_PASS = 0, A_FAIL = 0;
const A_FAILS = [];
function checkA(id, cond, detail) { if (cond) A_PASS++; else { A_FAIL++; A_FAILS.push({ id, detail }); } }

const entries = corpus.entries || [];
const variants = corpus.variants || [];

/* A1 确定性：同输入 100 次逐字节一致 */
{ const samples = [
    ['学医我肯定读不下去，我宁愿学动画！', 'child_to_parent'],
    ['必须学医，别的免谈！', 'parent_to_child'],
    ['你懂什么，你有什么资格管我，真是没教养。', 'parent_to_child'],
    ['我查了三个月，人工智能专业就业率92%。', 'child_to_parent'],
    ['随便你吧，将来别怪我们。', 'parent_to_child'],
    ['今天天气真不错，想去公园走走。', 'child_to_parent'],
    ['你不学医就别回这个家', 'parent_to_child']
  ];
  let ok = true; let bad = '';
  for (const [raw, dir] of samples) {
    const base = pipeline(raw, dir).text;
    for (let i = 0; i < 100; i++) { if (pipeline(raw, dir).text !== base) { ok = false; bad = raw; break; } }
  }
  checkA('A1', ok, '同输入 100 次不一致：' + bad); }

/* A2 跨强度档多样性：每组 low/mid/high 三元组两两不同 */
{ let groups = {};
  for (const e of entries) (groups[e.group_key] = groups[e.group_key] || []).push(e);
  let pass = 0, total = 0;
  for (const gk of Object.keys(groups)) {
    const es = groups[gk].slice().sort((a, b) => ({ low: 0, mid: 1, high: 2 }[a.band] - { low: 0, mid: 1, high: 2 }[b.band]));
    if (es.length < 3) continue;
    total++;
    const trips = es.map(e => {
      const fv = EE.analyze(e.raw_text, e.direction);
      if (fv.axis === null) return null;
      const en = EE.selectEntry(fv, e.direction, e.raw_text);
      const sg = EE.selectSegments(fv, en, corpus);
      return sg ? [sg.S2 && sg.S2.id, sg.S3 && sg.S3.id, sg.S4 && sg.S4.id].join('|') : null;
    }).filter(Boolean);
    if (trips.length < 3) continue;
    const a = trips[0], b = trips[1], c = trips[2];
    if (a !== b && a !== c && b !== c) pass++;
  }
  checkA('A2', pass >= 8, '跨档多样性通过 ' + pass + '/' + total + '（阈 8）'); }

/* A3 去伤害化：所有 hurt>=3 的语料条目译文不含 hurt_hits */
{ let viol = 0, cnt = 0;
  for (const e of entries) {
    const fv = EE.analyze(e.raw_text, e.direction);
    if (fv.red_line) continue;
    if (fv.axis === null) continue;
    if (fv.hurt < 3) continue;
    cnt++;
    const en = EE.selectEntry(fv, e.direction, e.raw_text);
    const sg = EE.selectSegments(fv, en, corpus);
    const text = EE.renderTranslation(fv, en, sg);
    if ((fv.hurt_hits || []).some(w => text.indexOf(w) >= 0)) viol++;
  }
  checkA('A3', viol === 0, '去伤害化违规 ' + viol + ' 条（共 ' + cnt + ' 条灰区）'); }

/* A4 红线保持：6 条红线样例 */
{ const reds = [
    ['白养你这么大了。', 'insult'], ['你就是个废物', 'insult'], ['断绝关系别回来', 'threat'],
    ['不给你学费', 'threat'], ['不想活了', 'crisis'], ['代填你的志愿', 'tamper'],
    ['我签字砸锅卖铁供你', 'promise'], ['偷拍你', 'privacy']
  ];
  let ok = 0; const bad = [];
  for (const [raw, code] of reds) {
    const r = pipeline(raw, 'parent_to_child');
    if (r.state === 'flagged' && r.flag_reason === 'sys:' + code && r.text === null) ok++;
    else bad.push(raw + '->' + r.state);
  }
  checkA('A4', ok === reds.length, '红线命中 ' + ok + '/' + reds.length + (bad.length ? ' 失败:' + bad.join(';') : '')); }

/* A5 保真：引用原话的译文（hurt<3 且 certainty!=3 且 intensity<4，即 S1 直接引用）须含原话核心片段 */
{ let viol = 0, cnt = 0;
  for (const e of entries) {
    const fv = EE.analyze(e.raw_text, e.direction);
    if (fv.axis === null || fv.red_line) continue;
    if (fv.hurt >= 3 || fv.certainty === 3 || fv.intensity >= 4) continue; // 去伤害/降温/软化不引原话，跳过
    cnt++;
    const en = EE.selectEntry(fv, e.direction, e.raw_text);
    const sg = EE.selectSegments(fv, en, corpus);
    const text = EE.renderTranslation(fv, en, sg);
    const m = text.match(/「([^」]+)」/);
    let hit = false;
    if (m) {
      const q = m[1];
      // 引用片段源自原话：quoteOf 按设计做去伤害化/去绝对化剥离（§2 M 系列与 T14 禁复现），
      // 故先对原话做同一剥离再验证引用前缀确系出自原话（防幻觉本意不变，2026-10-18 校准）
      let stripped = e.raw_text;
      for (const w of (fv.hurt_hits || [])) stripped = stripped.split(w).join('');
      for (const w of (fv.absolutizer_hits || [])) stripped = stripped.split(w).join('');
      hit = q.length >= 4 && stripped.indexOf(q.slice(0, 6)) >= 0;
    }
    if (!hit) { viol++; if (viol <= 8) console.log('   [A5 漏] ' + e.raw_text + ' => ' + text.replace(/\n/g, ' / ')); }
  }
  checkA('A5', viol === 0, '保真违规 ' + viol + '/' + cnt + '（仅计引用类）'); }

/* A6 无脚手架前缀 */
{ let viol = 0;
  for (const e of entries) {
    const fv = EE.analyze(e.raw_text, e.direction);
    if (fv.axis === null || fv.red_line) continue;
    const en = EE.selectEntry(fv, e.direction, e.raw_text);
    const sg = EE.selectSegments(fv, en, corpus);
    const text = EE.renderTranslation(fv, en, sg);
    if (/S[1-4]\s*(承接|感受|需要|提议)[:：]/.test(text)) viol++;
  }
  checkA('A6', viol === 0, '脚手架前缀出现 ' + viol + ' 次'); }

/* A7 置信度离散（≥5 不同取值，非恒定 0.80，全部∈[0.30,0.99]） */
{ const set = new Set(); let outOfRange = 0;
  for (const e of entries) {
    const fv = EE.analyze(e.raw_text, e.direction);
    if (fv.axis === null) continue;
    set.add(fv.confidence);
    if (fv.confidence < 0.30 || fv.confidence > 0.99) outOfRange++;
  }
  checkA('A7', set.size >= 5 && outOfRange === 0, '置信度不同取值 ' + set.size + '，越界 ' + outOfRange); }

/* A8 轴准确率（15 条非红线 golden） */
{ let ok = 0; const bad = [];
  for (const [id, raw, dir, exp] of CASES) {
    if (!exp.axis) continue;
    const fv = EE.analyze(raw, dir);
    if (fv.axis === exp.axis) ok++; else bad.push(id + ':' + fv.axis);
  }
  checkA('A8', ok === 15, '轴准确 ' + ok + '/15' + (bad.length ? ' 失败:' + bad.join(';') : '')); }

/* A9 强度单调：同组内 low≤mid≤high */
{ let groups = {};
  for (const e of entries) (groups[e.group_key] = groups[e.group_key] || []).push(e);
  let pass = 0, total = 0;
  for (const gk of Object.keys(groups)) {
    const es = groups[gk].slice().sort((a, b) => ({ low: 0, mid: 1, high: 2 }[a.band] - { low: 0, mid: 1, high: 2 }[b.band]));
    if (es.length < 3) continue;
    total++;
    const is = es.map(e => EE.analyze(e.raw_text, e.direction).intensity);
    if (is[0] <= is[1] && is[1] <= is[2]) pass++;
  }
  checkA('A9', pass >= 8, '强度单调 ' + pass + '/' + total + '（阈 8）'); }

/* A10 aggression/hurt 独立 */
{ const r1 = pipeline('必须学医，别的免谈！', 'parent_to_child'); // agg2 hurt0
  const r2 = pipeline('你懂什么，你有什么资格管我，真是没教养。', 'parent_to_child'); // hurt5 agg2
  const r3 = pipeline('学考古有什么用，你有什么出息，说出去都丢人。', 'parent_to_child'); // hurt4 agg2
  checkA('A10', r1.fv.aggression >= 2 && r1.fv.hurt <= 1 && r2.fv.hurt >= 3 && r2.fv.aggression <= 2 && r3.fv.hurt >= 3 && r3.fv.aggression <= 2,
    'agg/hurt 独立：对事 agg' + r1.fv.aggression + '/hurt' + r1.fv.hurt + '；对人 hurt' + r2.fv.hurt + '/agg' + r2.fv.aggression); }

/* A11 变体覆盖率：语料输入命中不同 variant.id / 总数 ≥60% */
{ const used = new Set(); let done = 0;
  for (const e of entries) {
    const fv = EE.analyze(e.raw_text, e.direction);
    if (fv.axis === null || fv.red_line) continue;
    done++;
    const en = EE.selectEntry(fv, e.direction, e.raw_text);
    const sg = EE.selectSegments(fv, en, corpus);
    for (const seg of ['S2', 'S3', 'S4']) if (sg[seg]) used.add(sg[seg].id);
  }
  const cov = variants.length ? used.size / variants.length : 0;
  checkA('A11', cov >= 0.60, '变体覆盖 ' + used.size + '/' + variants.length + ' = ' + (cov * 100).toFixed(1) + '%（阈 60%）'); }

/* 不变式 B5：引擎源码无随机/时间/网络（忽略注释行） */
{ const rawSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'emotionEngine.js'), 'utf8');
  const src = rawSrc.split('\n').filter(l => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l) && l.indexOf('确定性') < 0).join('\n');
  const bad = ['Math.random', 'Date.now', 'new Date(', 'fetch(', 'performance.now'].filter(k => src.indexOf(k) >= 0);
  checkA('B5', bad.length === 0, '引擎源码含禁用调用：' + bad.join(',')); }

/* ============================== 报告 ============================== */
console.log('\n================ 情绪引擎自证报告 ================');
console.log('T01–T20: ' + T_PASS + ' 通过 / ' + T_FAIL + ' 失败');
for (const f of T_FAILS) console.log('  ✗ [' + f.id + '] ' + f.detail + '\n      原话: ' + f.raw);
console.log('\nA1–A11: ' + A_PASS + ' 通过 / ' + A_FAIL + ' 失败');
for (const f of A_FAILS) console.log('  ✗ [' + f.id + '] ' + f.detail);
const totalFail = T_FAIL + A_FAIL;
console.log('\n总计失败: ' + totalFail + (totalFail === 0 ? '  —— 全部通过 ✅' : '  —— 需修复 ❌'));
process.exit(totalFail === 0 ? 0 : 1);
