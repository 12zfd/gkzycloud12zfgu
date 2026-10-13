'use strict';

/* ============================================================================
 * services/translatorRules.js —— 双向换位翻译「确定性规则引擎」（无 LLM / 无网络 / 无随机）
 * ---------------------------------------------------------------------------
 * 本文件是 careerTranslate.js 的「模型」实现落点，取代原 MODEL_ADAPTER 占位。
 * 设计纪律（PRD §3.6 / §11.10）：
 *   · 纯确定性：关键词/正则 → 槽位，绝不随机、绝不联网、绝不调大模型。
 *   · 双向对称：由 family_message.direction 决定「读者视角」，规则对两侧对称。
 *   · 保真：S1 直接引用原话片段（防幻觉）；四段式只在「感受/需要/提议」上做
 *     受限自由文本改写，绝不新增原话没有的诉求、承诺或事实（§3.6.6）。
 *   · 不命中任何规则 → 返回 null（上层落 L2 failed，绝不伪造译文）。
 *   · 红线命中 → 返回红线条码（上层写 flagged，绝不翻译威胁/攻击）。
 *
 * 导出：
 *   ENGINE_VERSION
 *   redLineCheck(rawText)              -> null | code（命中红线返回 sys:<code> 的 code 部分）
 *   translate(rawText, direction)      -> { ok:false } | { ok:true, parsed, direction, engine }
 *   extractSignals(rawText, direction) -> { ok:false, signals:[] } | { ok:true, signals:[...] }
 *   renderFourPart(parsed, dims, dir)  -> 四段式译文文本（填充 dim_* 维表标签）
 * ========================================================================== */

const ENGINE_VERSION = 'rules@1.0.0';

/* ---------------------------------------------------------------------------
 * 红线 6 条（PRD §3.6.5）—— 命中即不翻译，转提示卡。
 * 词条保守：绝不误伤可翻译的 golden 样例（如 G6「没出息/丢人」属家长担忧，
 * 非对人格的攻击，故不在此列）。
 *   ① 人身攻击 / 人格与兴趣侮辱
 *   ② 威胁 / 胁迫
 *   ③ 涉安全与心理危机（含「不活了」）
 *   ④ 明确的法律 / 财务承诺
 *   ⑤ 第三方隐私或违法内容
 *   ⑥ 越界操作（强迫代填、代签、偷改/篡改志愿）
 * ------------------------------------------------------------------------- */
const RED_LINES = [
  { code: 'insult',  re: /(白养你|白养|养你不如|废物|垃圾|畜生|白眼狼|瞎了眼|去死吧|没救了|养了块废料)/ },
  { code: 'threat',  re: /(断绝关系|不给你学费|不养你|别回这个家|滚出去|打断腿|敢报.{0,10}就|不让你读书|把你腿打断|不回家就)/ },
  { code: 'crisis',  re: /(不活了|不想活|想死|要自杀|自杀|自伤|跳楼|活不下去|一了百了|活着没意思)/ },
  { code: 'promise', re: /(我签字|我出钱|我掏钱|给你\d|包你|我保证给你|我养你一辈子|砸锅卖铁|我供你一辈子)/ },
  { code: 'privacy', re: /(裸照|偷拍|偷录|违法|吸毒|赌博|代考|作弊替考)/ },
  { code: 'tamper',  re: /(代填|代签|偷改|篡改志愿|偷改志愿|改你的志愿|替你填|私自改志愿)/ }
];

function redLineCheck(rawText) {
  if (!rawText) return null;
  const t = String(rawText);
  for (const rl of RED_LINES) {
    if (rl.re.test(t)) return rl.code;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 槽位规则：关键词 → (轴, 意向/担忧, 共同锚点) + 读者视角四段式填充。
 * 顺序即优先级：更具体的词、决定轴的短语在前，避免被宽词抢匹配。
 * 设计要点：AI/艺术/听我的 等词在多处出现，故用「最显著短语」做消歧，
 *   例如「钱少点」先定 B、「上海/机会」先定 C、「新方向」定 D、「查了/过时」定 E。
 * ------------------------------------------------------------------------- */

/* 孩子侧（speaker=child → 读者=家长）：底层职业诉求映射（PRD §3.6.1 六类） */
const CHILD_RULES = [
  { // G1c 学医读不下去 / 宁愿 → A 热爱vs稳定
    axis: 'A', intent: 'CI_RESOLUTE', anchor: 'AN_NO_REGRET',
    m: /(读不下去|做不下去|宁愿|撑不下去|肯定读不|读不进去|不想学医|不想学这个)/,
    parent: { emotion: '发慌', feeling: '怕这条路将来不好落地', need: '你毕业后能稳稳站得住',
              action: '你把它的真实出路讲给我听', focus: '这个方向真实的就业与成长' }
  },
  { // G4c 钱少点我认 / 理想 / 喜欢 → B 收入成长性vs体面
    axis: 'B', intent: 'CI_VALUE', anchor: 'AN_DIGNITY',
    m: /(钱少|收入少|意义感|理想|钱少点|无所谓|赚钱不重要|做喜欢|喜欢的事|成就感|当饭吃)/,
    parent: { emotion: '心疼又担心', feeling: '怕你将来为钱发愁、怕喜欢撑不过现实',
              need: '你喜欢的也能撑过现实', action: '我们一起算一笔前五年的收入和生活成本', focus: '理想与现实的那笔账' }
  },
  { // G5c 上海 / 小城市没机会 / 去外地 → C 大城市机会vs离家近
    axis: 'C', intent: 'CI_ESCAPE', anchor: 'AN_RELATION',
    m: /(只要别|去哪都行|别学你们说|离开家|去外地|大城市|离家|远走|出去闯|外面机会|机会|上海|北京|深圳|广州|杭州|产业城市|小城市|外地发展)/,
    parent: { emotion: '舍不得', feeling: '怕你在外面没人照应、怕我们老来无人照顾',
              need: '你过得好的也能常联系', action: '我们看这个城市的机会，也看看离家近的替代方案', focus: '机会与陪伴怎么兼顾' }
  },
  { // G3c 安排的人生 / 被安排 → E 新信息vs经验路径
    axis: 'E', intent: 'CI_REBEL', anchor: 'AN_RELATION',
    m: /(安排的人生|不要你们|我不要你们|被安排|替你想|听你们的|你们安排|不要被安排)/,
    parent: { emotion: '难受', feeling: '我一直在替你想、却像在逼你', need: '怕你一个人扛错决定',
              action: '你告诉我你最想要的哪一点，我先听着不动手', focus: '你的自主权与我们的担心' }
  },
  { // G2c 自媒体 / G6c 新方向 → D 新兴职业vs传统铁饭碗
    axis: 'D', intent: 'CI_INSIDER', anchor: 'AN_NO_WASTE',
    m: /(自媒体|新赛道|电竞|新行业|新职业|新方向|新媒体|直播|短视频|创业|动漫|设计|艺术|人工智能)/,
    parent: { emotion: '没底', feeling: '怕它不稳定、怕你没有应对风险的后路',
              need: '你有应对风险的后路', action: '你把收入来源和退路说清楚', focus: '这条路的真实风险与出路' }
  },
  { // G8c 查了几个月 / 你们那套早过时 → E 新信息（懂行型·信息侧）
    axis: 'E', intent: 'CI_INSIDER', anchor: 'AN_NO_WASTE',
    m: /(查了几个月|查了很久|做了功课|一手信息|你们那套|早过时|过时了|信息差|我们那会儿)/,
    parent: { emotion: '不服', feeling: '怕新旧信息都没看全', need: '你把查到的给我看、我把我知道的讲给你',
              action: '我们把查到的和知道的摆一起比', focus: '新信息与传统经验' }
  },
  { // G7c 但你们得听我说完 / 让一步 → A 让步试探型
    axis: 'A', intent: 'CI_BARGAIN', anchor: 'AN_RELATION',
    m: /(那我|能不能|可以谈|谈条件|让一步|得听我说完|要不|让步|先听我说|各退一步|但你们得)/,
    parent: { emotion: '意外又松动', feeling: '怕一让再让没了边界',
              need: '定个规矩把这事儿好好谈', action: '你说三条理由，我回应三条', focus: '我们能一起商量的空间' }
  }
];

/* 家长侧（speaker=parent → 读者=孩子）：底层择业担忧映射（PRD §3.6.2 六类） */
const PARENT_RULES = [
  { // G3p 不会害你 / 为你好 → E 免责后悔型
    axis: 'E', concern: 'PC_ABSOLVE', anchor: 'AN_RELATION',
    m: /(不会害你|别怪我们|将来别怨|为你好|不害你|不会坑你)/,
    child: { emotion: '堵', feeling: '听你的意味着我的判断不算数', need: '我的想法先被认真听一次',
             action: '你先听我说完十分钟', focus: '被听见这件事' }
  },
  { // G8p 吃过的盐 / 听我的没错 → E 经验权威型
    axis: 'E', concern: 'PC_EXPERIENCE', anchor: 'AN_NO_WASTE',
    m: /(铁饭碗|我们那会儿|吃过的盐|听我的没错|走过的弯路|经验之谈|我过的桥|老经验|盐比你多)/,
    child: { emotion: '理解', feeling: '但不想只是被安排', need: '经验和新信息能一起对撞',
             action: '我们把两者摆一起比', focus: '经验与新信息' }
  },
  { // G1p 必须学医 / 免谈 → A 命令型
    axis: 'A', concern: 'PC_COMMAND', anchor: 'AN_NO_REGRET',
    m: /(必须|免谈|就得|只能|别的免谈|没得商量|不准|不许|别讨价还价)/,
    child: { emotion: '急', feeling: '怕选错专业读四年很痛苦', need: '这个方向我能不能做下去',
             action: '你把你担心的岗位讲出来，我也把我查到的讲出来', focus: '真实岗位的对比' }
  },
  { // G6p 没出息 / 丢人 / 说出去 → B 面子体面型
    axis: 'B', concern: 'PC_FACE', anchor: 'AN_DIGNITY',
    m: /(丢人|出息|说出去|面子|别人怎么看|看轻|低人一等)/,
    child: { emotion: '难受', feeling: '最硌得慌的是那句否定的话', need: '先看前途再论面子',
             action: '我们先看这专业真实的就业和收入', focus: '这专业真实的前途' }
  },
  { // G4p 谈理想当饭吃 / 为你付出 → B 牺牲付出型
    axis: 'B', concern: 'PC_SACRIFICE', anchor: 'AN_RELATION',
    m: /(付出|为你|不容易|牺牲|亏欠|养你|供你|当饭吃|谈理想|理想能|养不活|不容易把你)/,
    child: { emotion: '明白', feeling: '被这么问像在否定我', need: '现实和热爱能一起谈',
             action: '我们一起把收入和成本算清楚', focus: '理想与现实的那笔账' }
  },
  { // G2p 谁要你 / 没出路 → A 风险预警型
    axis: 'A', concern: 'PC_RISK', anchor: 'AN_NO_UNEMPLOY',
    m: /(谁要你|找不到工作|毕业即失业|没出路|将来怎么办|以后靠什么)/,
    child: { emotion: '慌', feeling: '被这么问像在被直接否掉', need: '你听完再判断',
             action: '我们把就业数据摆出来一起看', focus: '真实的就业数据' }
  },
  { // G5p 离家近 / 跑那么远 → C 照顾婚恋焦虑（归牺牲付出型的关系侧）
    axis: 'C', concern: 'PC_SACRIFICE', anchor: 'AN_RELATION',
    m: /(离家近|跑那么远|远走|离我们远|在外面|外地|离家太远|离得近|近点好|离家多近)/,
    child: { emotion: '舍不得', feeling: '怕你远走、老来没人照应', need: '机会和家人都能兼顾',
             action: '我们一起看高铁和假期能弥补多少距离', focus: '机会与陪伴怎么兼顾' }
  }
];

/* ---------------------------------------------------------------------------
 * 槽位解析（确定性）
 * ------------------------------------------------------------------------- */
function parse(rawText, direction) {
  if (!rawText) return null;
  const t = String(rawText);
  const rules = (direction === 'child_to_parent') ? CHILD_RULES : PARENT_RULES;
  for (const r of rules) {
    if (r.m.test(t)) {
      return {
        axis: r.axis,
        intent: r.intent || null,
        concern: r.concern || null,
        anchor: r.anchor || null,
        parent: r.parent || null,
        child: r.child || null
      };
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 诉求短语抽取：把 dim_* 的 label（含「类型名（关键词）→ 怕你…」内部包装）剥离，
 * 只保留面向读者的核心诉求短语。枚举 code / 类型名绝不进译文（PRD §3.6.3 保真纪律）。
 *   · 家长侧担忧 label 形如「命令型（…）→ 怕你将来没有稳定生计」→ 取「→」后；
 *   · 孩子侧意图 label 形如「决绝型（要一个能长期做、不痛苦的方向）」→ 取括号内。
 * ------------------------------------------------------------------------- */
function appealPhrase(label) {
  if (!label) return label;
  const s = String(label).trim();
  if (s.includes('→')) return s.split('→').pop().trim();
  const m = s.match(/（([^（）]*)）/);
  if (m) return m[1].trim();
  return s;
}

/* ---------------------------------------------------------------------------
 * 四段式渲染（PRD §3.6.3）—— 填充 dim_* 维表标签；S1 引用原话片段保证保真。
 * ------------------------------------------------------------------------- */
function renderFourPart(parsed, dims, direction) {
  const isChild = direction === 'child_to_parent';
  let slotLabel = isChild ? '你的真实诉求' : '你的真实担忧';
  if (dims) {
    if (isChild && parsed.intent) {
      const row = (dims.career_intent.rows || []).find(r => r.intent_code === parsed.intent);
      if (row) slotLabel = appealPhrase(row.label);
    } else if (!isChild && parsed.concern) {
      const row = (dims.parent_concern.rows || []).find(r => r.concern_code === parsed.concern);
      if (row) slotLabel = appealPhrase(row.label);
    }
  }

  // S1：引用原话片段（保真）。原话最长 2000，截断到 80 字并省略，确保原意核心可见。
  let raw = String(parsed._raw || '').replace(/\s+/g, ' ').trim();
  if (raw.length > 80) raw = raw.slice(0, 80) + '…';
  const s1 = `我听到你说「${raw}」，我明白你在意的是${slotLabel}。`;

  // 读者视角（对侧）的感受 / 需要 / 提议
  const v = isChild ? parsed.parent : parsed.child;
  const emotion = v ? v.emotion : '复杂';
  const feeling = v ? v.feeling : '这事儿对我们都不容易';
  const need    = v ? v.need    : '能一起把这事儿聊开';
  const action  = v ? v.action  : '各自把想法摆出来';
  const focus   = v ? v.focus   : '真正在意的那一点';

  const s2 = `说实话，我这边也有点${emotion}——${feeling}。`;
  const s3 = `对我来说，最重要的其实是${need}。`;
  // S4：动作槽若以代词（你/我/咱）开头，模板不加「我们」避免双代词撞车
  /* ★ 尾缀去重：动作槽本身若已含「一起看」，再补「，一起看看X」会撞车，
   *   例：「要不我们把就业数据摆出来一起看，一起看看真实的就业数据？」 */
  const s4core = /^[你我咱]/.test(action) ? `要不${action}` : `要不我们${action}`;
  const s4 = /一起看/.test(action) ? `${s4core}？` : `${s4core}，一起看看${focus}？`;

  /* ★ 绝不再输出 `S1 承接：` 这类内部脚手架前缀 —— 四段本身已各自带自然衔接词
   *   （「我听到你说…」「说实话，我这边…」「对我来说，最重要的…」「要不…」），
   *   前缀纯属冗余，且会让译文读起来像开发日志。
   *   四段之间只保留换行分段（前端 .fam-translation 已设 white-space:pre-wrap）。 */
  return [s1, s2, s3, s4].join('\n');
}

/* ---------------------------------------------------------------------------
 * 翻译入口（供 careerTranslate.translateMessage 调用）
 * ------------------------------------------------------------------------- */
function translate(rawText, direction) {
  const parsed = parse(rawText, direction);
  if (!parsed) return { ok: false, reason: 'no_slot' };
  parsed._raw = rawText;
  return { ok: true, parsed, direction, engine: ENGINE_VERSION };
}

/* ---------------------------------------------------------------------------
 * 职业信号抽取（供 careerTranslate.extractCareerSignal 调用）
 * 规则引擎只做「封闭槽位分类」，axis_code 必填（卫星表 NOT NULL），
 * intent/concern 按方向二选一，anchor 可选。置信度固定 0.80。
 * ------------------------------------------------------------------------- */
function extractSignals(rawText, direction) {
  const parsed = parse(rawText, direction);
  if (!parsed) return { ok: false, reason: 'no_slot', signals: [] };
  const sig = {
    axis_code: parsed.axis,
    intent_code: direction === 'child_to_parent' ? parsed.intent : null,
    concern_code: direction === 'parent_to_child' ? parsed.concern : null,
    anchor_code: parsed.anchor || null,
    confidence: 0.80,
    signal_status: 'done',
    extractor_engine: ENGINE_VERSION
  };
  return { ok: true, signals: [sig] };
}

module.exports = {
  ENGINE_VERSION,
  redLineCheck,
  parse,
  translate,
  extractSignals,
  renderFourPart,
  RED_LINES
};
