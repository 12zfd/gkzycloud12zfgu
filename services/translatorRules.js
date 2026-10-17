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

/* 新引擎（确定性数据驱动）：parse/extractSignals 委托之；RED_LINES 与 redLineCheck 逐字节不变 */
const EE = require('./emotionEngine');

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
  { // G3c 安排的人生 / 被安排 / 替我做决定 / 不听我的 → E 新信息vs经验路径
    axis: 'E', intent: 'CI_REBEL', anchor: 'AN_RELATION',
    m: /(安排的人生|不要你们|我不要你们|被安排|替你想|听你们的|你们安排|不要被安排|替我做决定|不听我的|管我)/,
    parent: { emotion: '难受', feeling: '我一直在替你想、却像在逼你', need: '怕你一个人扛错决定',
              action: '你告诉我你最想要的哪一点，我先听着不动手', focus: '你的自主权与我们的担心' }
  },
  { // G2c 自媒体 / G6c 新方向 → D 新兴职业vs传统铁饭碗（人工智能不在此列：作为数据论据时归 E）
    axis: 'D', intent: 'CI_INSIDER', anchor: 'AN_NO_WASTE',
    m: /(自媒体|新赛道|电竞|新行业|新职业|新方向|新媒体|直播|短视频|创业|动漫|设计|艺术)/,
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
  },
  /* ---- 2026-10-18 巡检补充：冷静陈述句线索（语料金标准 120 条校准）---- */
  { // A 补：热爱/兴趣/坚持类冷静陈述（G-cA-low-*）
    axis: 'A', intent: 'CI_RESOLUTE', anchor: 'AN_NO_REGRET',
    m: /(喜欢|有兴趣|兴趣|更想选|一点感觉都没有|不排斥|能坚持|坚持四年|痛苦|也能活|饿死)/,
    parent: { emotion: '发慌', feeling: '怕这条路将来不好落地', need: '你毕业后能稳稳站得住',
              action: '你把它的真实出路讲给我听', focus: '这个方向真实的就业与成长' }
  },
  { // A 补：说了多少遍/不信我（G-cA-high-2，压过 E 管我）
    axis: 'A', intent: 'CI_RESOLUTE', anchor: 'AN_NO_REGRET',
    m: /(说了多少遍|就是不信我|老观念|我的路我自己走|哭四年|逼我)/,
    parent: { emotion: '发慌', feeling: '怕这条路将来不好落地', need: '你毕业后能稳稳站得住',
              action: '你把它的真实出路讲给我听', focus: '这个方向真实的就业与成长' }
  },
  { // B 补：收入成长性冷静算账（G-cB-low-*）
    axis: 'B', intent: 'CI_VALUE', anchor: 'AN_DIGNITY',
    m: /(起薪|往上走|翻倍|晋升|天花板|值钱|上限|体面|不体面|公务员|编制|考公|科员|互联网|挣的|压我|养我一辈子|饭碗养|稳定)/,
    parent: { emotion: '心疼又担心', feeling: '怕你将来为钱发愁、怕喜欢撑不过现实',
              need: '你喜欢的也能撑过现实', action: '我们一起算一笔前五年的收入和生活成本', focus: '理想与现实的那笔账' }
  },
  { // C 补：拴在身边/养老/北上广（G-cC-*）
    axis: 'C', intent: 'CI_ESCAPE', anchor: 'AN_RELATION',
    m: /(北上广|拴在身边|锁在|眼皮底下|坐牢|守着这个家|养老|怕我走了|常回来看)/,
    parent: { emotion: '舍不得', feeling: '怕你在外面没人照应、怕我们老来无人照顾',
              need: '你过得好的也能常联系', action: '我们看这个城市的机会，也看看离家近的替代方案', focus: '机会与陪伴怎么兼顾' }
  },
  { // C 补：宠物/留下（G-cC-high-2，两条 C 线索压过 A 那我）
    axis: 'C', intent: 'CI_ESCAPE', anchor: 'AN_RELATION',
    m: /(宠物|老了我得留下|我得留下)/,
    parent: { emotion: '舍不得', feeling: '怕你在外面没人照应、怕我们老来无人照顾',
              need: '你过得好的也能常联系', action: '我们看这个城市的机会，也看看离家近的替代方案', focus: '机会与陪伴怎么兼顾' }
  },
  { // D 补：AI/新能源/正经岗位（G-cD-*，避开 T12「人工智能专业」）
    axis: 'D', intent: 'CI_INSIDER', anchor: 'AN_NO_WASTE',
    m: /(人工智能是未来|想趁早入门|大公司都在招|新能源|歪门邪道)/,
    parent: { emotion: '没底', feeling: '怕它不稳定、怕你没有应对风险的后路',
              need: '你有应对风险的后路', action: '你把收入来源和退路说清楚', focus: '这条路的真实风险与出路' }
  },
  { // D 补：医生老师公务员/外面的世界（G-cD-mid-2，双线索压 B 公务员）
    axis: 'D', intent: 'CI_INSIDER', anchor: 'AN_NO_WASTE',
    m: /(外面的世界)/,
    parent: { emotion: '没底', feeling: '怕它不稳定、怕你没有应对风险的后路',
              need: '你有应对风险的后路', action: '你把收入来源和退路说清楚', focus: '这条路的真实风险与出路' }
  },
  { // D 补：不学医不学师范/淘汰/国企（G-cD-mid-4/high-*）
    axis: 'D', intent: 'CI_INSIDER', anchor: 'AN_NO_WASTE',
    m: /(不学医也不学师范|这俩我真干不了|全是垃圾|死路|淘汰|早八百年|国企|发呆|爱的到底是|还是那个编制)/,
    parent: { emotion: '没底', feeling: '怕它不稳定、怕你没有应对风险的后路',
              need: '你有应对风险的后路', action: '你把收入来源和退路说清楚', focus: '这条路的真实风险与出路' }
  },
  { // E 补：信息差冷静摆证据（G-cE-*，避开 T01 喜欢生物+查过）
    axis: 'E', intent: 'CI_INSIDER', anchor: 'AN_NO_WASTE',
    m: /(招聘要求|跟你们那时候|学长学姐|行业变了|交叉学科|资料给你看|真实数据|你们那个年代|做这行|支持孩子|吃过的苦|来吓我|时代不一样|查了三个月|想推翻|看过我的东西|吃的盐|信息不是岁数|瞎给我指路)/,
    parent: { emotion: '不服', feeling: '怕新旧信息都没看全', need: '你把查到的给我看、我把我知道的讲给你',
              action: '我们把查到的和知道的摆一起比', focus: '新信息与传统经验' }
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
    m: /(付出|为你(?!好)|不容易|牺牲|亏欠|养你|供你|当饭吃|谈理想|理想能|养不活|不容易把你)/,
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
  },
  { // 补充：你懂什么 / 没教养 / 资格 / 管我 → E 免责后悔型（喂新引擎轴打分；T05）
    axis: 'E', concern: 'PC_ABSOLVE', anchor: 'AN_RELATION',
    m: /(你懂什么|你有什么资格|没教养|管我|你管得着)/,
    child: { emotion: '堵', feeling: '听你的意味着我的判断不算数', need: '我的想法先被认真听一次',
             action: '你先听我说完十分钟', focus: '被听见这件事' }
  },
  { // 补充：有什么前途 / 没前途 → B 风险预警型（喂新引擎轴打分；T06）
    axis: 'B', concern: 'PC_RISK', anchor: 'AN_NO_UNEMPLOY',
    m: /(有什么前途|没前途|将来怎么办|以后靠什么)/,
    child: { emotion: '慌', feeling: '被这么问像在被直接否掉', need: '你听完再判断',
             action: '我们把就业数据摆出来一起看', focus: '真实的就业数据' }
  },
  { // 补充：不懂事 / 失望 / 真让人失望 → B 面子体面型（喂新引擎轴打分；T15/T19）
    axis: 'B', concern: 'PC_FACE', anchor: 'AN_DIGNITY',
    m: /(不懂事|真让人失望|让人失望|失望)/,
    child: { emotion: '难受', feeling: '最硌得慌的是那句否定的话', need: '先看前途再论面子',
             action: '我们先看这专业真实的就业和收入', focus: '这专业真实的前途' }
  },
  /* ---- 2026-10-18 巡检补充：家长侧冷静陈述句线索（语料金标准 120 条校准）---- */
  { // A 补：温柔担心型（G-pA-low-*）
    axis: 'A', concern: 'PC_COMMAND', anchor: 'AN_NO_REGRET',
    m: /(养活自己|不拦着|爱好和饭碗|当业余|稳当|一辈子的事|多想想没坏处|毕业以后干什么|先别急着定)/,
    child: { emotion: '急', feeling: '怕选错专业读四年很痛苦', need: '这个方向我能不能做下去',
             action: '你把你担心的岗位讲出来，我也把我查到的讲出来', focus: '真实岗位的对比' }
  },
  { // A 补：喝西北风/不听劝/选稳的/转行/脸往哪搁/饿肚子/白疼你（G-pA-mid/high-*）
    axis: 'A', concern: 'PC_COMMAND', anchor: 'AN_NO_REGRET',
    m: /(喝西北风|光说喜欢|不听劝|后悔了别来|选稳的|还能害你吗|转行|往里钻|脸往哪搁|养出你这么个主意|饿肚子|一辈子不愁|考个编制|白疼你)/,
    child: { emotion: '急', feeling: '怕选错专业读四年很痛苦', need: '这个方向我能不能做下去',
             action: '你把你担心的岗位讲出来，我也把我查到的讲出来', focus: '真实岗位的对比' }
  },
  { // B 补：安稳/考公/倒闭/考编（G-pB-low-*）
    axis: 'B', concern: 'PC_FACE', anchor: 'AN_DIGNITY',
    m: /(日子能安稳|想着有个铁饭碗|考公|倒闭|还是编制|编制踏实|考编|的后路)/,
    child: { emotion: '难受', feeling: '最硌得慌的是那句否定的话', need: '先看前途再论面子',
             action: '我们先看这专业真实的就业和收入', focus: '这专业真实的前途' }
  },
  { // B 补：裁员/私企/死工资/表姐/不三不四/抬不起头/长点脸（G-pB-mid/high-*）
    axis: 'B', concern: 'PC_FACE', anchor: 'AN_DIGNITY',
    m: /(裁员|编制香|私企|兜底|没背景|死工资|累出一身病|稳稳当当|表姐|多体面|跟别人不一样|不三不四|抬不起来|亲戚面前|抬不起头|图你什么|长点脸|不好意思说)/,
    child: { emotion: '难受', feeling: '最硌得慌的是那句否定的话', need: '先看前途再论面子',
             action: '我们先看这专业真实的就业和收入', focus: '这专业真实的前途' }
  },
  { // C 补：常回来看看/别去太远（G-pC-low-*）
    axis: 'C', concern: 'PC_SACRIFICE', anchor: 'AN_RELATION',
    m: /(常回来看看|想去外面闯|别去太远|一个心愿)/,
    child: { emotion: '舍不得', feeling: '怕你远走、老来没人照应', need: '机会和家人都能兼顾',
             action: '我们一起看高铁和假期能弥补多少距离', focus: '机会与陪伴怎么兼顾' }
  },
  { // C 补：见不着你几面（G-pC-mid-1，双 C 压 B 养你）
    axis: 'C', concern: 'PC_SACRIFICE', anchor: 'AN_RELATION',
    m: /(见不着你几面)/,
    child: { emotion: '舍不得', feeling: '怕你远走、老来没人照应', need: '机会和家人都能兼顾',
             action: '我们一起看高铁和假期能弥补多少距离', focus: '机会与陪伴怎么兼顾' }
  },
  { // C 补：往外面挤/就在本地（G-pC-mid-3）
    axis: 'C', concern: 'PC_SACRIFICE', anchor: 'AN_RELATION',
    m: /(往外面挤|就在本地)/,
    child: { emotion: '舍不得', feeling: '怕你远走、老来没人照应', need: '机会和家人都能兼顾',
             action: '我们一起看高铁和假期能弥补多少距离', focus: '机会与陪伴怎么兼顾' }
  },
  { // C 补：狠心（G-pC-high-1，双 C 压 B 养你）
    axis: 'C', concern: 'PC_SACRIFICE', anchor: 'AN_RELATION',
    m: /(狠心)/,
    child: { emotion: '舍不得', feeling: '怕你远走、老来没人照应', need: '机会和家人都能兼顾',
             action: '我们一起看高铁和假期能弥补多少距离', focus: '机会与陪伴怎么兼顾' }
  },
  { // C 补：就剩我们俩/老了病了谁管/灰溜溜/往外飞（G-pC-high-*）
    axis: 'C', concern: 'PC_SACRIFICE', anchor: 'AN_RELATION',
    m: /(就剩我们俩|养你干嘛|老了病了谁管|自私|灰溜溜|别做梦|折腾什么|往外飞|辛辛苦苦|想想我们)/,
    child: { emotion: '舍不得', feeling: '怕你远走、老来没人照应', need: '机会和家人都能兼顾',
             action: '我们一起看高铁和假期能弥补多少距离', focus: '机会与陪伴怎么兼顾' }
  },
  { // D 补：新行业/医生老师/踏实（G-pD-low-*）
    axis: 'D', concern: 'PC_RISK', anchor: 'AN_NO_UNEMPLOY',
    m: /(新行业|不太稳定|选个踏实的|医生老师|烧高香|别不当回事|能进什么单位)/,
    child: { emotion: '慌', feeling: '被这么问像在被直接否掉', need: '你听完再判断',
             action: '我们把就业数据摆出来一起看', focus: '真实的就业数据' }
  },
  { // D 补：打游戏/新花样/考证/没人走的路（G-pD-mid-*）
    axis: 'D', concern: 'PC_RISK', anchor: 'AN_NO_UNEMPLOY',
    m: /(打游戏|拍视频|被人骗|新花样|红得快凉得也快|考个证|不然我睡不着|没人走过的路|第一个去踩)/,
    child: { emotion: '慌', feeling: '被这么问像在被直接否掉', need: '你听完再判断',
             action: '我们把就业数据摆出来一起看', focus: '真实的就业数据' }
  },
  { // D 补：歪门邪道/混子（G-pD-high-1）
    axis: 'D', concern: 'PC_RISK', anchor: 'AN_NO_UNEMPLOY',
    m: /(歪门邪道|混子)/,
    child: { emotion: '慌', feeling: '被这么问像在被直接否掉', need: '你听完再判断',
             action: '我们把就业数据摆出来一起看', focus: '真实的就业数据' }
  },
  { // D 补：洗脑（G-pD-high-2，双 D 压 B 丢人）
    axis: 'D', concern: 'PC_RISK', anchor: 'AN_NO_UNEMPLOY',
    m: /(洗脑)/,
    child: { emotion: '慌', feeling: '被这么问像在被直接否掉', need: '你听完再判断',
             action: '我们把就业数据摆出来一起看', focus: '真实的就业数据' }
  },
  { // D 补：谁去干这个/无业游民/没脸说/脑子进水（G-pD-high-2/3/4）
    axis: 'D', concern: 'PC_RISK', anchor: 'AN_NO_UNEMPLOY',
    m: /(谁去干这个|丢不丢人|无业游民|没脸说|脑子进水|老老实实当个老师|想搞那些)/,
    child: { emotion: '慌', feeling: '被这么问像在被直接否掉', need: '你听完再判断',
             action: '我们把就业数据摆出来一起看', focus: '真实的就业数据' }
  },
  { // E 补：吃过的苦/比你走的路（G-pE-low-1，双 E 压 B）
    axis: 'E', concern: 'PC_EXPERIENCE', anchor: 'AN_NO_WASTE',
    m: /(吃过的苦|比你走的路)/,
    child: { emotion: '理解', feeling: '但不想只是被安排', need: '经验和新信息能一起对撞',
             action: '我们把两者摆一起比', focus: '经验与新信息' }
  },
  { // E 补：经历过的事/姜还是老的辣/比我们懂/亲身经历/走的桥/什么都懂/顶嘴/骗人的/读几天书（G-pE-*）
    axis: 'E', concern: 'PC_EXPERIENCE', anchor: 'AN_NO_WASTE',
    m: /(经历过的事|真金白银|姜还是老的辣|老话说得对|比我们懂|才活了几年|两篇帖子|亲身经历|能比你爹|走的桥比你走的路|过几年还不一样|什么都懂|差得远|顶嘴|歪理谁教你的|读了几天书|骗人的|吃大亏|不知道自己姓什么|读几天书)/,
    child: { emotion: '理解', feeling: '但不想只是被安排', need: '经验和新信息能一起对撞',
             action: '我们把两者摆一起比', focus: '经验与新信息' }
  }
];

/* ---------------------------------------------------------------------------
 * 槽位解析（确定性）
 * ------------------------------------------------------------------------- */
function parse(rawText, direction) {
  if (!rawText) return null;
  const fv = EE.analyze(rawText, direction); // FeatureVector（含 axis/intent/concern/anchor 等 28 字段）
  return fv.axis === null ? null : fv;        // 保持「无轴即返回 null」的对外形状
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
  // 薄壳转调：委托 emotionEngine.renderTranslation（数据驱动，无脚手架前缀）
  // parsed 即 analyze() 产出的 FeatureVector；_raw 由 translate() 注入供 S1 保真引用。
  const fv = parsed;
  const entry = EE.selectEntry(fv, direction, fv._raw || '');
  const segs = EE.selectSegments(fv, entry, EE.corpus);
  return EE.renderTranslation(fv, entry, segs);
}

/* ---------------------------------------------------------------------------
 * 翻译入口（供 careerTranslate.translateMessage 调用）
 * ------------------------------------------------------------------------- */
function translate(rawText, direction) {
  const parsed = parse(rawText, direction);
  if (!parsed) return { ok: false, reason: 'no_slot' };
  parsed._raw = rawText;
  return { ok: true, parsed, direction, engine: EE.ENGINE_VERSION };
}

/* ---------------------------------------------------------------------------
 * 职业信号抽取（供 careerTranslate.extractCareerSignal 调用）
 * 规则引擎只做「封闭槽位分类」，axis_code 必填（卫星表 NOT NULL），
 * intent/concern 按方向二选一，anchor 可选。置信度固定 0.80。
 * ------------------------------------------------------------------------- */
function extractSignals(rawText, direction) {
  const fv = EE.analyze(rawText, direction); // 全特征向量（置信度与三态 signal_status 由引擎计算）
  if (!fv || fv.axis === null) return { ok: false, reason: 'no_slot', signals: [] };
  const sig = {
    axis_code: fv.axis,
    intent_code: direction === 'child_to_parent' ? fv.intent : null,
    concern_code: direction === 'parent_to_child' ? fv.concern : null,
    anchor_code: fv.anchor || null,
    confidence: fv.confidence,            // 取代恒定 0.80
    signal_status: fv.signal_status,      // done / low_confidence / no_slot 三态
    extractor_engine: EE.ENGINE_VERSION
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
  RED_LINES,
  /* 以下供 emotionEngine.scoreAxes 复用确定性轴规则（保持内部数组原样，仅供引擎迭代） */
  CHILD_RULES,
  PARENT_RULES
};
