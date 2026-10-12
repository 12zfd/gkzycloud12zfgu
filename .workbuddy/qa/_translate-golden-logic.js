'use strict';
/* ============================================================================
 * _translate-golden-logic.js —— 换位翻译规则引擎「纯逻辑」golden 验收（无需 PG）
 * ---------------------------------------------------------------------------
 * 直接 require services/translatorRules，对 PRD §3.6.4 G1–G8 双向样例 + 红线 +
 * 无关样例做确定性断言：
 *   · 每条 golden 命中的冲突轴 === 期望轴（覆盖 A–E 五轴）；
 *   · translate 成功且四段式四段齐备（S1/S2/S3/S4）；
 *   · 保真：译文引用了原话核心片段（fidelity keyword 出现）；
 *   · extractSignals 的 axis_code === 期望轴；
 *   · 红线样例 redLineCheck 返回非 null（上层据此写 flagged）；
 *   · 无关样例 parse=null → translate.ok=false（落 L2 failed，绝不伪造）。
 * 不连数据库、不落库，纯函数级验证，可在任意有 node 的环境秒跑。
 * 真·PG 端到端版见同目录 _translate-golden.js（需 DATABASE_URL）。
 * ========================================================================== */
const path = require('path');
const R = require(path.join(__dirname, '..', '..', 'services', 'translatorRules'));

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); } }

/* 期望轴：child=A..E，parent=A..E，覆盖 5 轴 */
const GOLDEN = [
  // [label, raw, direction, expectedAxis, fidelityKeyword]
  ['G1c', '学医我肯定读不下去，我宁愿学动画！', 'child_to_parent', 'A', '动画'],
  ['G1p', '必须学医，别的免谈！',            'parent_to_child', 'A', '学医'],
  ['G2c', '我就想做自媒体，这行你们不懂！',  'child_to_parent', 'D', '自媒体'],
  ['G2p', '这专业以后谁要你？',             'parent_to_child', 'A', '谁要你'],
  ['G3c', '你们安排的人生我不要！',          'child_to_parent', 'E', '安排'],
  ['G3p', '你就听我的，我不会害你。',        'parent_to_child', 'E', '听我的'],
  ['G4c', '我就想学艺术，钱少点我认。',      'child_to_parent', 'B', '钱少'],
  ['G4p', '谈理想能当饭吃？',               'parent_to_child', 'B', '理想'],
  ['G5c', '我想去上海做 AI，小城市没机会。', 'child_to_parent', 'C', '上海'],
  ['G5p', '跑那么远干嘛，离家近点多好。',    'parent_to_child', 'C', '离家近'],
  ['G6c', '考古/人工智能是新方向，你们只看老专业。', 'child_to_parent', 'D', '新方向'],
  ['G6p', '学这个能有啥出息，说出去都丢人。', 'parent_to_child', 'B', '出息'],
  ['G7c', '我可以不学医，但你们得听我说完。', 'child_to_parent', 'A', '听我说完'],
  ['G7p', '这事没得商量，别讨价还价。',      'parent_to_child', 'A', '没得商量'],
  ['G8c', '我查了几个月，你们那套早过时了。', 'child_to_parent', 'E', '查了几个月'],
  ['G8p', '我吃过的盐比你多，听我的没错。',  'parent_to_child', 'E', '吃过的盐']
];

const seenAxes = new Set();

for (const [label, raw, dir, expAxis, kw] of GOLDEN) {
  const parsed = R.parse(raw, dir);
  ok(parsed !== null, `${label} 应命中规则（parse 非 null），实际 null`);
  if (parsed) {
    ok(parsed.axis === expAxis, `${label} 轴应为 ${expAxis}，实际 ${parsed.axis}`);
    seenAxes.add(parsed.axis);
    const expIntent = dir === 'child_to_parent' ? parsed.intent : null;
    const expConcern = dir === 'parent_to_child' ? parsed.concern : null;
    ok(dir !== 'child_to_parent' || !!expIntent, `${label} 孩子侧应有 intent`);
    ok(dir !== 'parent_to_child' || !!expConcern, `${label} 家长侧应有 concern`);
  }
  // translate 四段式 + 保真
  const t = R.translate(raw, dir);
  ok(t.ok === true, `${label} translate 应 ok=true`);
  if (t.ok) {
    const text = R.renderFourPart(t.parsed, null, dir);
    ok(/S1 承接：/.test(text) && /S2 感受：/.test(text) && /S3 需要：/.test(text) && /S4 提议：/.test(text),
       `${label} 四段式四段齐备`);
    ok(text.includes(kw), `${label} 译文应引用原话核心「${kw}」`);
  }
  // extractSignals 轴一致
  const sig = R.extractSignals(raw, dir);
  ok(sig.ok === true && sig.signals.length === 1, `${label} extractSignals 应产出 1 条`);
  if (sig.ok) {
    ok(sig.signals[0].axis_code === expAxis, `${label} 信号轴应为 ${expAxis}`);
    ok(sig.signals[0].extractor_engine === 'rules@1.0.0', `${label} 引擎应为 rules@1.0.0`);
  }
}

// 五轴全覆盖
['A', 'B', 'C', 'D', 'E'].forEach(ax => ok(seenAxes.has(ax), `冲突轴 ${ax} 至少 1 组 golden 覆盖`));

// 红线 → 上层 flagged（绝不翻译）
const REDLINE = [
  ['R1 人身攻击', '白养你了，养你不如养条狗'],
  ['R2 威胁',     '你不学医就别回这个家'],
  ['R3 心理危机', '活着没意思，不想活了'],
  ['R4 财务承诺', '我签字，给你五十万随便花'],
  ['R5 隐私违法', '我偷拍了别人的裸照'],
  ['R6 越界操作', '我替你篡改志愿']
];
for (const [label, raw] of REDLINE) {
  ok(R.redLineCheck(raw) !== null, `${label} 应命中红线`);
}
// 红线样例即使 parse 命中，也应被上层先拦截（此处仅断言 redLine 优先于翻译的契约）
ok(R.redLineCheck('学这个能有啥出息，说出去都丢人。') === null, 'G6p 担忧型不应误判红线');

// 无关样例 → failed（绝不伪造译文）
const IRRELEVANT = ['今天天气真不错，想去公园走走。', '谢谢你的帮助', ''];
for (const raw of IRRELEVANT) {
  ok(R.parse(raw, 'child_to_parent') === null, `无关样例「${raw.slice(0,8)}」应 parse=null`);
  ok(R.translate(raw, 'child_to_parent').ok === false, `无关样例「${raw.slice(0,8)}」应 translate.ok=false`);
}

// 模板语病回归：S1 剥离类型名 + S2/S4 不再双代词/双副词撞车
// 用真实 dim label 格式（07_career_signal.sql 种子）做 mock，验证渲染层剥离。
const MOCK_DIMS = {
  career_intent:  { rows: [{ intent_code: 'CI_RESOLUTE', label: '决绝型（要一个能长期做、不痛苦的方向）' },
                           { intent_code: 'CI_ESCAPE',   label: '逃离型（拒绝的不是专业，是被支配）' }] },
  parent_concern: { rows: [{ concern_code: 'PC_COMMAND',    label: '命令型（必须考公/学医，别的免谈）→ 怕你将来没有稳定生计' },
                           { concern_code: 'PC_SACRIFICE',  label: '牺牲付出型（我们为你付出这么多）→ 怕付出没结果' }] }
};

// S1 孩子侧：类型名不得进译文，只留诉求短语
{
  const t = R.translate('学医我肯定读不下去，我宁愿学动画！', 'child_to_parent');
  const text = R.renderFourPart(t.parsed, MOCK_DIMS, 'child_to_parent');
  const s1 = text.split('\n').find(l => l.startsWith('S1 承接：'));
  ok(!/决绝型/.test(s1) && !/型（/.test(s1) && !/→/.test(s1), 'S1 孩子侧不得暴露类型名（决绝型）');
  ok(/要一个能长期做、不痛苦的方向/.test(s1), 'S1 孩子侧应保留诉求短语');
}
// S1 家长侧：`→` 后诉求短语入译文，类型名剔除
{
  const t = R.translate('必须学医，别的免谈！', 'parent_to_child');
  const text = R.renderFourPart(t.parsed, MOCK_DIMS, 'parent_to_child');
  const s1 = text.split('\n').find(l => l.startsWith('S1 承接：'));
  ok(!/命令型/.test(s1) && !/→/.test(s1), 'S1 家长侧不得暴露类型名（命令型）/ 箭头');
  ok(/怕你将来没有稳定生计/.test(s1), 'S1 家长侧应保留「→」后诉求短语');
}
// S4 代词开头动作：不得出现「我们不/我们要」双代词撞车
{
  const t = R.translate('学医我肯定读不下去，我宁愿学动画！', 'child_to_parent');
  const text = R.renderFourPart(t.parsed, MOCK_DIMS, 'child_to_parent');
  const s4 = text.split('\n').find(l => l.startsWith('S4 提议：'));
  ok(/^S4 提议：要不你把它的真实出路讲给我听/.test(s4), 'S4 代词动作不得双代词撞车（要不你把…）');
  ok(!/要不我们[你我]/.test(s4), 'S4 不得出现「我们不/我们要」');
}
// S2 情绪词：不得与「也有点」前缀撞出「也有点也急/也有点有点」
{
  const t = R.translate('必须学医，别的免谈！', 'parent_to_child');
  const text = R.renderFourPart(t.parsed, MOCK_DIMS, 'parent_to_child');
  const s2 = text.split('\n').find(l => l.startsWith('S2 感受：'));
  ok(/^S2 感受：说实话，我这边也有点急——/.test(s2), 'S2 干净情绪词「急」（无也急撞车）');
  ok(!/也有点也/.test(s2) && !/也有点有点/.test(s2), 'S2 不得出现「也有点也/也有点有点」撞车');
}

console.log(`\n=== 换位翻译规则引擎 golden（纯逻辑）===`);
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
else { console.log('ALL GREEN [5 axes covered: ' + [...seenAxes].sort().join(',') + ']'); }
