'use strict';

/* ============================================================================
 * services/translationCorpus.js —— 语料库（确定性、无 IO、可 require）
 * ---------------------------------------------------------------------------
 * 结构化落地用户研究员语料（notes-corpus-career-conflict-2026-10-13.md）：
 *   · entries[]  —— 120 条原话（2 方向 × 5 轴 × 3 强度档 × 4 条）
 *   · variants[] —— 可生成句子变体池（segment × band × axis 通用/专用，每格 ≥2）
 *   · slot_catalog / lexicons —— 槽位与词典镜像（供审计/校验）
 *
 * 本模块在 require 时纯函数式构建语料对象（无文件/网络 IO、无随机、无时间），
 * 满足「可离线、可 golden」的确定性约束。引擎 analyze() 的词典在 emotionEngine.js，
 * 此处 lexicons 为 schema 镜像（供校验脚本比对）。
 *
 * 覆盖矩阵：30 组合（2×5×3）每组合 4 条，变体池按 (segment×band) 每格 ≥2 条，
 * 无空格；抽样核对见模块末尾 buildCoverageReport()。
 * ========================================================================== */

/* ---- 共同锚点标签（dim_common_anchor 镜像，供 {anchor_label} 槽解析）---- */
const ANCHOR_LABELS = {
  AN_NO_REGRET: '不后悔的选择',
  AN_DIGNITY: '体面与尊严',
  AN_RELATION: '我们的关系',
  AN_NO_WASTE: '不浪费的尝试',
  AN_NO_UNEMPLOY: '不失业的底线'
};

/* ---- (方向, 轴) → 锚点 / 意图 / 担忧（沿用既有 CHILD_RULES/PARENT_RULES 首条）---- */
const DIR_AXIS = {
  child_to_parent: {
    A: { anchor: 'AN_NO_REGRET', intent: 'CI_RESOLUTE',  concern: null },
    B: { anchor: 'AN_DIGNITY',   intent: 'CI_VALUE',     concern: null },
    C: { anchor: 'AN_RELATION',  intent: 'CI_ESCAPE',    concern: null },
    D: { anchor: 'AN_NO_WASTE',  intent: 'CI_INSIDER',   concern: null },
    E: { anchor: 'AN_RELATION',  intent: 'CI_REBEL',     concern: null }
  },
  parent_to_child: {
    A: { anchor: 'AN_NO_REGRET', intent: null, concern: 'PC_COMMAND' },
    B: { anchor: 'AN_DIGNITY',   intent: null, concern: 'PC_FACE' },
    C: { anchor: 'AN_RELATION',  intent: null, concern: 'PC_SACRIFICE' },
    D: { anchor: 'AN_NO_UNEMPLOY', intent: null, concern: 'PC_RISK' },
    E: { anchor: 'AN_RELATION',  intent: null, concern: 'PC_ABSOLVE' }
  }
};

/* ---- 每 (方向, 轴) 默认槽位（focus/need/action/feeling/emotion…），供渲染填充 ---- */
const DEFAULT_SLOTS = {
  'child_to_parent:A': { focus: '这个方向真实的就业与成长', need: '你毕业后能稳稳站得住', action: '你把它的真实出路讲给我听', feeling: '怕这条路将来不好落地', emotion: '发慌', emotion2: '担心' },
  'child_to_parent:B': { focus: '理想与现实的那笔账', need: '你喜欢的也能撑过现实', action: '我们一起算一笔前五年的收入和生活成本', feeling: '怕你将来为钱发愁、怕喜欢撑不过现实', emotion: '心疼又担心', emotion2: '担心' },
  'child_to_parent:C': { focus: '机会与陪伴怎么兼顾', need: '你过得好的也能常联系', action: '我们看这个城市的机会，也看看离家近的替代方案', feeling: '怕你在外面没人照应、怕我们老来无人照顾', emotion: '舍不得', emotion2: '担心' },
  'child_to_parent:D': { focus: '这条路的真实风险与出路', need: '你有应对风险的后路', action: '你把收入来源和退路说清楚', feeling: '怕它不稳定、怕你没有应对风险的后路', emotion: '没底', emotion2: '担心' },
  'child_to_parent:E': { focus: '新信息与传统经验', need: '你把查到的给我看、我把我知道的讲给你', action: '我们把查到的和知道的摆一起比', feeling: '怕新旧信息都没看全', emotion: '不服', emotion2: '担心' },
  'parent_to_child:A': { focus: '真实岗位的对比', need: '这个方向我能不能做下去', action: '你把你担心的岗位讲出来，我也把我查到的讲出来', feeling: '怕选错专业读四年很痛苦', emotion: '急', emotion2: '担心' },
  'parent_to_child:B': { focus: '这专业真实的前途', need: '先看前途再论面子', action: '我们先看这专业真实的就业和收入', feeling: '最硌得慌的是那句否定的话', emotion: '难受', emotion2: '担心' },
  'parent_to_child:C': { focus: '机会与陪伴怎么兼顾', need: '机会和家人都能兼顾', action: '我们一起看高铁和假期能弥补多少距离', feeling: '怕你远走、老来没人照应', emotion: '舍不得', emotion2: '担心' },
  'parent_to_child:D': { focus: '真实的就业数据', need: '你听完再判断', action: '我们把就业数据摆出来一起看', feeling: '被这么问像在被直接否掉', emotion: '慌', emotion2: '担心' },
  'parent_to_child:E': { focus: '经验与新信息', need: '经验和新信息能一起对撞', action: '我们把两者摆一起比', feeling: '但不想只是被安排', emotion: '理解', emotion2: '担心' }
};

/* ---- 120 条原话（顺序即覆盖矩阵行序）：[原话, 方向, 轴, 强度档, 诉求类别, 换位要点] ---- */
const CORPUS_ROWS = [
  // —— child_to_parent · A 热爱vs稳定 ——
  ['妈，我是真的喜欢生物，不是一时兴起，我把这专业能做什么都查过了', 'child_to_parent', 'A', 'low', '要一个能长期做下去的方向', '让孩子被听成做过功课的认真选择'],
  ['我知道学医稳定，可我读下来会很痛苦，我更想选一个能坚持四年的', 'child_to_parent', 'A', 'low', '要一个能长期做下去的方向', '让孩子被听成在权衡利弊'],
  ['我查了传媒的课程，越看越有兴趣，我想试试', 'child_to_parent', 'A', 'low', '要意义感优先于收入', '让家长听到这是他主动研究过的方向'],
  ['爸，我不排斥稳定，只是不想为了稳定去学一个我一点感觉都没有的专业', 'child_to_parent', 'A', 'low', '要自主决定权', '让孩子被听成想要方向感'],
  ['我都说过我喜欢画画了，你们怎么就是听不进去，非让我去学会计', 'child_to_parent', 'A', 'mid', '要自主决定权', '让孩子被听成反复表达未果的委屈'],
  ['生物是我的命，你们让我学不喜欢的，我这四年怎么过啊', 'child_to_parent', 'A', 'mid', '要一个能长期做下去的方向', '让孩子被听成恐惧四年痛苦'],
  ['你们总说稳定稳定，你们问过我喜欢什么吗', 'child_to_parent', 'A', 'mid', '要自主决定权', '让孩子被听成想被纳入决策'],
  ['我学这个也能活，你们别老觉得我会饿死行不行', 'child_to_parent', 'A', 'mid', '要一个能长期做下去的方向', '让孩子被听成有能力为自己负责'],
  ['你们根本不懂现在的行情，就守着你们那点老观念，我的路我自己走！', 'child_to_parent', 'A', 'high', '要被当懂行的人', '让家长听出孩子感到信息被彻底否定'],
  ['我说了多少遍别拿你们那套来管我，你们就是不信我！', 'child_to_parent', 'A', 'high', '要自主决定权', '让家长听出长期不被信任的受伤'],
  ['你们就是怕亲戚问起来没面子才逼我学医，这跟我的前途有什么关系！', 'child_to_parent', 'A', 'high', '要拒绝被支配', '让家长听出孩子成了面子的工具'],
  ['为你们喜欢的专业哭四年的是我，不是你们，你们凭什么替我做决定！', 'child_to_parent', 'A', 'high', '要自主决定权', '让家长听出孩子愿意承担后果只求决定权'],
  // —— child_to_parent · B 收入成长性vs体面 ——
  ['我算过，这个专业起薪是不高，但做得好三五年能翻倍，我看重的是往上走的空间', 'child_to_parent', 'B', 'low', '要成长空间与上限', '让家长听到孩子在用数字谈未来'],
  ['编制是稳，可我这性格坐不住办公室，我想找一份能越做越值钱的工作', 'child_to_parent', 'B', 'low', '要成长空间与上限', '让家长听成并非嫌弃编制而是了解自己'],
  ['我查了这个行业的晋升路径，前几年辛苦，但天花板高，我愿意熬', 'child_to_parent', 'B', 'low', '要成长空间与上限', '让孩子被听成清楚风险仍愿承担'],
  ['我不是看不上稳定工作，只是想趁年轻试试上限更高的路', 'child_to_parent', 'B', 'low', '要成长空间与上限', '让家长听成孩子在试探而非否定'],
  ['你们张口闭口就是编制，编制是能当饭吃，可我这辈子就为这个活着吗', 'child_to_parent', 'B', 'mid', '要意义感优先于收入', '让孩子被听成不想把人生只押在稳定上'],
  ['学计算机怎么就不体面了，你们眼里只有公务员才叫工作吗', 'child_to_parent', 'B', 'mid', '要成长空间与上限', '让家长听出孩子职业被贬低后的委屈'],
  ['你们就知道稳定，稳定能治我妈天天念叨的焦虑，可治不了我', 'child_to_parent', 'B', 'mid', '要意义感优先于收入', '让孩子被听成需要自己的安全感定义'],
  ['我同学进互联网一年挣的顶我表哥编制三年，你们怎么就不信呢', 'child_to_parent', 'B', 'mid', '要被当懂行的人', '让家长听到孩子有真实数据支撑判断'],
  ['你们就是嫌我挣得不够体面，好拿出去跟人比是吧，我这辈子又不是活给你们同事看的！', 'child_to_parent', 'B', 'high', '要意义感优先于收入', '让家长听出孩子被当攀比工具'],
  ['编制编制，你们满脑子就这两个字，你们有想过我想要什么吗！', 'child_to_parent', 'B', 'high', '要自主决定权', '让孩子被听成长期被忽视的信号'],
  ['我要是真听你们去考公，混一辈子科员，你们才满意是不是！', 'child_to_parent', 'B', 'high', '要成长空间与上限', '让家长听出孩子怕人生被压在低上限里'],
  ['别拿你那个铁饭碗压我了，你那饭碗养了你自己，别想养我一辈子！', 'child_to_parent', 'B', 'high', '要拒绝被支配', '让家长听出孩子想自立而非依附'],
  // —— child_to_parent · C 大城市机会vs离家近 ——
  ['我想去杭州学电商，那边产业多、实习机会多，离家高铁也就三小时', 'child_to_parent', 'C', 'low', '要去有产业的城市搏一把', '让家长听到孩子已把距离考虑进去'],
  ['妈，北京那个专业全国最好，我想去，但我答应你每个月视频，放假就回来', 'child_to_parent', 'C', 'low', '要去有产业的城市搏一把', '让孩子被听成兼顾而非抛弃'],
  ['我想去深圳，那边做硬件的公司多，我想去实地看看', 'child_to_parent', 'C', 'low', '要去有产业的城市搏一把', '让家长听到孩子想去看真实机会'],
  ['我愿意在省内读，但也想去大城市见识两年，这算过分吗', 'child_to_parent', 'C', 'low', '要用让步换被认真讨论的机会', '让孩子被听成在寻求允许而非对抗'],
  ['小城市哪有 AI 的公司啊，你们让我留在这，我学出来能干嘛', 'child_to_parent', 'C', 'mid', '要去有产业的城市搏一把', '让家长听出孩子专业需要产业土壤'],
  ['你们就想着把我拴在身边，我上大学又不是去坐牢', 'child_to_parent', 'C', 'mid', '要自主决定权', '让家长听出孩子怕被过度保护'],
  ['我同学都去外面了，就你们非得让我守着这个家', 'child_to_parent', 'C', 'mid', '要去有产业的城市搏一把', '让孩子被听成怕错过机会'],
  ['我说的机会你们不当回事，就觉得离家近了才是好', 'child_to_parent', 'C', 'mid', '要被当懂行的人', '让孩子被听成诉求被简化后的失落'],
  ['你们就是想把我锁在眼皮底下，你们有没有想过我想过什么样的人生！', 'child_to_parent', 'C', 'high', '要自主决定权', '让家长听出孩子被过度控制的窒息感'],
  ['为了你们老了我得留下，那我这辈子算什么，我是你们养的宠物吗！', 'child_to_parent', 'C', 'high', '要意义感优先于收入', '让家长听出孩子怕人生被养老义务绑架'],
  ['你们嘴上说为我好，其实就是怕我走了没人给你们养老！', 'child_to_parent', 'C', 'high', '要拒绝被支配', '让家长听出孩子感到被工具化'],
  ['别人家孩子去北上广你们羡慕，到我这儿就成不孝了，凭什么！', 'child_to_parent', 'C', 'high', '要自主决定权', '让家长听出孩子被双标对待的委屈'],
  // —— child_to_parent · D 新兴职业vs传统铁饭碗 ——
  ['我想学数字媒体，以后做短视频运营，这是现在很正经的岗位，不是玩', 'child_to_parent', 'D', 'low', '要新赛道被认可', '让家长听到这是有明确岗位的技能方向'],
  ['游戏设计也是正经工作，一个团队几十号人靠这个吃饭', 'child_to_parent', 'D', 'low', '要新赛道被认可', '让家长知道这行是有产业链的'],
  ['人工智能是未来的方向，我想趁早入门，很多大公司都在招', 'child_to_parent', 'D', 'low', '要新赛道被认可', '让孩子被听成在抓趋势'],
  ['爸，我知道你看不上电竞，但现在战队也有正经合同，我想先去了解', 'child_to_parent', 'D', 'low', '要新赛道被认可', '让家长听成孩子在谨慎试探'],
  ['电竞怎么就不正经了，你们那会儿打游戏被骂，现在打游戏能进亚运会', 'child_to_parent', 'D', 'mid', '要新赛道被认可', '让家长听出标准变了孩子信息更新了'],
  ['你们就知道医生老师公务员，外面的世界什么样你们根本不知道', 'child_to_parent', 'D', 'mid', '要被当懂行的人', '让家长听出孩子想让父母更新认知'],
  ['我们班一半人想学 AI 和新能源，就你们还觉得这些是歪门邪道', 'child_to_parent', 'D', 'mid', '要新赛道被认可', '让家长听出这不是个别选择'],
  ['我不学医也不学师范，不是要气你们，是这俩我真干不了', 'child_to_parent', 'D', 'mid', '要一个能长期做下去的方向', '让孩子被听成是能力限制而非叛逆'],
  ['你们眼里除了铁饭碗别的全是垃圾，你们这是把我往死路上逼！', 'child_to_parent', 'D', 'high', '要新赛道被认可', '让家长听出孩子选择被全面否定的绝望'],
  ['做自媒体怎么了，你们同事孩子做代购你都夸，我做正经内容你嫌丢人，双标！', 'child_to_parent', 'D', 'high', '要被当懂行的人', '让家长听出孩子被双重标准伤害'],
  ['你们那套铁饭碗逻辑早八百年就该淘汰了，还拿出来管我！', 'child_to_parent', 'D', 'high', '要新赛道被认可', '让家长听出孩子认为父母信息过时'],
  ['你们宁愿我进个国企天天发呆，也不愿意让我做喜欢的事，你们爱的到底是我还是那个编制！', 'child_to_parent', 'D', 'high', '要意义感优先于收入', '让家长听出孩子怀疑父母爱的是面子不是自己'],
  // —— child_to_parent · E 新信息vs经验路径 ——
  ['爸，我查了这行的招聘要求，跟你们那时候真不一样了，我把资料给你看', 'child_to_parent', 'E', 'low', '要被当懂行的人', '让家长听成孩子想一起看事实'],
  ['你们的经验我记着，可现在行业变了，我想把新的情况也讲给你们听', 'child_to_parent', 'E', 'low', '要被当懂行的人', '让家长听成孩子想补充而非否定'],
  ['我想上一个新开的交叉学科，老师说是先做交叉，我再想想', 'child_to_parent', 'E', 'low', '要新赛道被认可', '让孩子被听成在谨慎判断'],
  ['妈，我搜了很多学长学姐的分享，跟你说的不太一样，我们一起看看', 'child_to_parent', 'E', 'low', '要被当懂行的人', '让家长听成孩子在邀请而非对抗'],
  ['你们那套早就行不通了，现在谁还像你们那个年代一样找工作', 'child_to_parent', 'E', 'mid', '要被当懂行的人', '让家长听出孩子认为规则已变'],
  ['我说的是真实数据，你们非说你们那个年代怎样怎样，能一样吗', 'child_to_parent', 'E', 'mid', '要被当懂行的人', '让家长听出孩子想用数据说话'],
  ['我同学他爸就是做这行的，人家都支持孩子，就你们老觉得不行', 'child_to_parent', 'E', 'mid', '要被当懂行的人', '让孩子被听成渴望家长支持'],
  ['你们别总拿你们吃过的苦来吓我，时代不一样了', 'child_to_parent', 'E', 'mid', '要拒绝被支配', '让家长听出孩子想被平等讨论'],
  ['你们那点老经验早过时了，还拿出来教育我，你们凭什么觉得自己对！', 'child_to_parent', 'E', 'high', '要被当懂行的人', '让家长听出孩子信息来源被全盘否定'],
  ['我查了三个月资料，你们一句话就想推翻，你们有认真看过我的东西吗！', 'child_to_parent', 'E', 'high', '要被当懂行的人', '让家长听出孩子努力被无视的委屈'],
  ['你们吃的盐多，盐吃多了不怕齁着吗，现在讲的是信息不是岁数！', 'child_to_parent', 'E', 'high', '要被当懂行的人', '让家长听出孩子抗拒以资历压人'],
  ['你们根本不懂现在的就业什么样，就别瞎给我指路了行不行！', 'child_to_parent', 'E', 'high', '要自主决定权', '让家长听出孩子认为建议脱离现实'],
  // —— parent_to_child · A 热爱vs稳定 ——
  ['孩子，爸不拦着你喜欢，就是想让你算算，这个方向能不能养活自己', 'parent_to_child', 'A', 'low', '怕你将来没有稳定生计', '让孩子听到担心生计而非否定兴趣'],
  ['爱好和饭碗是两码事，喜欢的东西可以当业余，工作还是得稳当点', 'parent_to_child', 'A', 'low', '怕你将来没有稳定生计', '让孩子听出家长在区分兴趣与营生'],
  ['我们都支持你有想法，但选专业是一辈子的事，多想想没坏处', 'parent_to_child', 'A', 'low', '怕你走我当年走过的弯路', '让孩子听出是顾虑而非命令'],
  ['你先别急着定，妈妈想听听这个专业毕业以后干什么', 'parent_to_child', 'A', 'low', '怕你毕业即失业', '让孩子听出家长想了解而非否决'],
  ['你光说喜欢有什么用，喜欢能当饭吃吗，将来喝西北风你找谁去', 'parent_to_child', 'A', 'mid', '怕你将来没有稳定生计', '让孩子听出家长对生计的真实恐慌'],
  ['你这孩子就是不听劝，等你以后后悔了别来找我们', 'parent_to_child', 'A', 'mid', '怕日后被埋怨', '让孩子听出家长怕被埋怨又放不下'],
  ['我们做父母的还能害你吗，我让你选稳的，是为了你好', 'parent_to_child', 'A', 'mid', '付出焦虑／怕不被理解', '让孩子听出家长的善意与被误解的委屈'],
  ['你说的那个专业，邻居家孩子学了都转行了，你还往里钻', 'parent_to_child', 'A', 'mid', '怕你走我当年走过的弯路', '让孩子听出家长基于案例的担忧'],
  ['我养你十八年，就养出你这么个主意，你说学这个，我这张脸往哪搁！', 'parent_to_child', 'A', 'high', '付出焦虑／怕被看清', '让孩子听出家长把付出与面子绑在一起'],
  ['你要是非得学那个，以后找不到工作别怪我没提醒过你，我不管了！', 'parent_to_child', 'A', 'high', '怕日后被埋怨', '让孩子听出家长怕担责又放不下'],
  ['你懂什么，考个编制一辈子不愁，等你在外面饿肚子哭都来不及！', 'parent_to_child', 'A', 'high', '怕你将来没有稳定生计', '让孩子听出家长用最坏画面表达担心'],
  ['别人家孩子都听爸妈的学医，就你翅膀硬了要飞，我白疼你了！', 'parent_to_child', 'A', 'high', '付出焦虑／怕被辜负', '让孩子听出家长的付出感与被抛弃感'],
  // —— parent_to_child · B 收入成长性vs体面 ——
  ['我们不是非要你考公，就是想着有个铁饭碗，你以后日子能安稳点', 'parent_to_child', 'B', 'low', '怕你将来没有稳定生计', '让孩子听出父母要的是安稳'],
  ['你说的那个公司待遇是不错，可万一倒闭了呢，还是编制踏实', 'parent_to_child', 'B', 'low', '怕你毕业即失业', '让孩子听出家长的风险感'],
  ['收入高低是其次，主要是有个单位、说出去体面，你懂的', 'parent_to_child', 'B', 'low', '怕被亲友看轻', '让孩子听出体面在家长价值里的分量'],
  ['你可以去企业，但我们希望你留条考编的后路，这不冲突吧', 'parent_to_child', 'B', 'low', '怕你毕业即失业', '让孩子听出家长在找折中方案'],
  ['你现在觉得钱多好，等你三十岁被裁员你就知道编制香了', 'parent_to_child', 'B', 'mid', '怕你毕业即失业', '让孩子听出家长用未来风险劝服'],
  ['我们家没背景没人脉，你进那些私企，出了事谁给你兜底', 'parent_to_child', 'B', 'mid', '怕你毕业即失业', '让孩子听出家长的现实焦虑'],
  ['挣得多有什么用，累出一身病，还不如稳稳当当拿死工资', 'parent_to_child', 'B', 'mid', '怕你受累', '让孩子听出家长把稳定当保护'],
  ['你表姐考了编制，现在多体面，你非要跟别人不一样', 'parent_to_child', 'B', 'mid', '怕被亲友看轻', '让孩子听出家长对从众安全的依赖'],
  ['你要是去干那种不三不四的工作，我们在亲戚面前头都抬不起来！', 'parent_to_child', 'B', 'high', '怕被亲友看轻', '让孩子听出家长被面子绑架'],
  ['挣那么多钱有什么用，人前都抬不起头，我们图你什么了！', 'parent_to_child', 'B', 'high', '怕被亲友看轻', '让孩子听出家长把体面看得比收入重'],
  ['你就知道钱钱钱，你眼里还有这个家吗，养你这么大就为了让你气我！', 'parent_to_child', 'B', 'high', '付出焦虑／怕不被理解', '让孩子听出家长的付出感与被冷落感'],
  ['别人问起来我都不好意思说你是干什么的，你就不能给我们长点脸！', 'parent_to_child', 'B', 'high', '怕被亲友看轻', '让孩子听出家长把体面绑在孩子职业上'],
  // —— parent_to_child · C 大城市机会vs离家近 ——
  ['去大城市我不反对，就是离家太远，爸妈有点舍不得', 'parent_to_child', 'C', 'low', '怕你远走、空巢', '让孩子听到是舍不得而非阻拦'],
  ['你想去外面闯，我们支持，就是想你能常回来看看', 'parent_to_child', 'C', 'low', '怕你远走、空巢', '让孩子听出家长的情感需求'],
  ['省内也有不错的学校，离家近，你有什么事我们也能搭把手', 'parent_to_child', 'C', 'low', '怕你远走、老来没人照顾', '让孩子听出家长想当后盾'],
  ['你去哪个城市都行，妈就一个心愿，别去太远，行吗', 'parent_to_child', 'C', 'low', '怕你远走、空巢', '让孩子听出家长的示弱而非命令'],
  ['你非要跑那么远，以后过年都见不着你几面，养你有什么用', 'parent_to_child', 'C', 'mid', '怕你远走、空巢', '让孩子听出家长对空巢的恐惧'],
  ['女孩子跑那么远干嘛，人生地不熟的，出了事我们连夜都赶不过去', 'parent_to_child', 'C', 'mid', '怕你远走、老来没人照顾', '让孩子听出家长的安全焦虑'],
  ['你哥哥就在本地，多好，你非得学人家往外面挤', 'parent_to_child', 'C', 'mid', '怕你远走、空巢', '让孩子听出家长以熟悉为安全'],
  ['你在外面要是想家哭了，可别怪我们当初没拦你', 'parent_to_child', 'C', 'mid', '怕日后被埋怨', '让孩子听出家长的心疼与免责并存'],
  ['你走了这个家就剩我们俩了，你怎么就这么狠心，早知道养你干嘛！', 'parent_to_child', 'C', 'high', '怕你远走、空巢', '让孩子听出空巢焦虑与被抛弃感'],
  ['你去那么远，将来我们老了病了谁管，你这孩子怎么这么自私！', 'parent_to_child', 'C', 'high', '怕你远走、老来没人照顾', '让孩子听出家长对养老的恐惧'],
  ['你去大城市折腾什么，到头来还不是灰溜溜回来，别做梦了！', 'parent_to_child', 'C', 'high', '怕你受挫／走弯路', '让孩子听出家长怕孩子失败受挫'],
  ['我们辛辛苦苦把你养大，就是让你往外飞的，你怎么不想想我们！', 'parent_to_child', 'C', 'high', '付出焦虑／怕被抛弃', '让孩子听出家长的付出感与被需要感'],
  // —— parent_to_child · D 新兴职业vs传统铁饭碗 ——
  ['你说的那个新行业我不懂，但听着不太稳定，咱还是选个踏实的', 'parent_to_child', 'D', 'low', '怕你追新踩坑', '让孩子听出家长的不确定感'],
  ['医生老师永远是需要的，你选这些错不了，妈是过来人', 'parent_to_child', 'D', 'low', '怕你走我当年走过的弯路', '让孩子听出家长用传统安全垫表达爱'],
  ['你想学就学，但得给妈讲清楚，这个将来能进什么单位', 'parent_to_child', 'D', 'low', '怕你毕业即失业', '让孩子听出家长需要确定性'],
  ['我们那会儿能有个铁饭碗就烧高香了，你可别不当回事', 'parent_to_child', 'D', 'low', '怕你走我当年走过的弯路', '让孩子听出家长的年代经验'],
  ['整天打游戏、拍视频能算正经工作，你别被人骗了还不知道', 'parent_to_child', 'D', 'mid', '怕你追新踩坑／被骗', '让孩子听出家长对新行业的污名恐惧'],
  ['这些新花样红得快凉得也快，你把青春耗进去，将来拿什么吃饭', 'parent_to_child', 'D', 'mid', '怕你追新踩坑', '让孩子听出家长对新兴行业的风险判断'],
  ['你要学可以，但得答应妈，毕业考个证留条后路，不然我睡不着', 'parent_to_child', 'D', 'mid', '怕你毕业即失业', '让孩子听出家长的焦虑转移为条件'],
  ['你看谁家孩子学这个了，没人走过的路，你非要第一个去踩', 'parent_to_child', 'D', 'mid', '怕你走我当年走过的弯路', '让孩子听出家长对无人验证路径的恐惧'],
  ['你学的这些歪门邪道，将来就是社会上的混子，我丢不起这人！', 'parent_to_child', 'D', 'high', '怕被亲友看轻', '让孩子听出家长把新职业等同于不体面'],
  ['你是不是被人洗脑了，正经家庭的孩子谁去干这个，你丢不丢人！', 'parent_to_child', 'D', 'high', '怕被亲友看轻／被骗', '让孩子听出家长用羞辱表达恐惧'],
  ['你学那个将来就是个无业游民，亲戚问起来我都没脸说，你怎么这么不懂事！', 'parent_to_child', 'D', 'high', '怕被亲友看轻', '让孩子听出家长把不体面视为家庭耻辱'],
  ['别人家孩子老老实实当个老师，就你脑子进水了想搞那些，气死我了！', 'parent_to_child', 'D', 'high', '怕被亲友看轻', '让孩子听出家长的从众焦虑转为人身攻击'],
  // —— parent_to_child · E 新信息vs经验路径 ——
  ['我们吃过的苦比你走的路多，这些话是为你好，你慢慢就懂了', 'parent_to_child', 'E', 'low', '怕你走我当年走过的弯路', '让孩子听出家长的经验关怀'],
  ['你查的东西也许对，但我们经历过的事，也是真金白银换来的', 'parent_to_child', 'E', 'low', '权威受损／经验被轻视', '让孩子听出家长希望经验被尊重'],
  ['你先别急着否定我们，我们说的也是为你好，你多听听没坏处', 'parent_to_child', 'E', 'low', '怕你走我当年走过的弯路', '让孩子听出家长怕经验价值被抹掉'],
  ['你说的我也去了解了解，但老话说得对，姜还是老的辣', 'parent_to_child', 'E', 'low', '权威受损／想保话语权', '让孩子听出家长想保住话语权'],
  ['你上网看两篇帖子就觉得比我们懂，你才活了几年', 'parent_to_child', 'E', 'mid', '权威受损／被冒犯', '让孩子听出家长因信息劣势的防御'],
  ['书上说的、网上说的，能比你爹亲身经历靠谱，你分得清好坏吗', 'parent_to_child', 'E', 'mid', '权威受损／被冒犯', '让孩子听出家长的权威焦虑'],
  ['我们走的桥比你走的路多，你那些新东西，过几年还不一样', 'parent_to_child', 'E', 'mid', '怕你走我当年走过的弯路', '让孩子听出家长用经验安慰自己'],
  ['你别以为上了几年学就什么都懂，社会上的事你差得远', 'parent_to_child', 'E', 'mid', '怕你受挫／能力质疑', '让孩子听出家长怕孩子社会经验不足'],
  ['你懂个屁，我们吃过的盐比你吃的米多，轮得到你来教育我！', 'parent_to_child', 'E', 'high', '权威受损／被冒犯', '让孩子听出家长被挑战权威后的激烈防御'],
  ['读了几天书就翅膀硬了，敢跟我顶嘴了，你这些歪理谁教你的！', 'parent_to_child', 'E', 'high', '权威受损／被冒犯', '让孩子听出家长把讨论当成冒犯'],
  ['你那些网上看来的都是骗人的，你要是信那个，早晚吃大亏哭都来不及！', 'parent_to_child', 'E', 'high', '怕你追新踩坑／被骗', '让孩子听出家长的恐惧型保护'],
  ['我们活了五十岁还不如你一个学生，我看你就是读几天书不知道自己姓什么了！', 'parent_to_child', 'E', 'high', '权威受损／被冒犯', '让孩子听出家长以资历和羞辱维护权威']
];

/* ---- 变体模板池（segment × 强度档 / 专用档）---- */
const S2_POOL = {
  low: [
    { t: '我能明白这背后你其实在意{anchor_label}。', frame: 'F-UNDERSTAND', tags: ['warm'] },
    { t: '说真的，我听进去了，你是在意{need}。', frame: 'F-HEAR', tags: ['warm'] }
  ],
  mid: [
    { t: '说实话，我这边也有点{emotion}——{feeling}。', frame: 'F-HONEST', tags: ['warm'] },
    { t: '我懂你着急，我其实也不是非要拧着来。', frame: 'F-EMPATH', tags: ['deescalate'] },
    { t: '我听到你这话里有点{emotion}，我也一样会纠结。', frame: 'F-SHARE', tags: ['warm'] }
  ],
  high: [
    { t: '我知道你现在{emotion}，我这边其实也{emotion2}，咱们先把话说慢点。', frame: 'F-DUAL-ACK', tags: ['deescalate', 'dual_ack'] },
    { t: '你这句说得很重，我先接住——我也在意{feeling}。', frame: 'F-CATCH', tags: ['deescalate'] }
  ],
  hurt: [
    { t: '你那句话我听到了；我真正担心的其实不是你这个人，是{focus}。', frame: 'F-DEHURT', tags: ['dehurt', 'warm'] },
    { t: '我想说的不是你不行，是这个选择我担心。', frame: 'F-DEHURT2', tags: ['dehurt'] }
  ]
};
const S3_POOL = {
  low: [
    { t: '对我来说，最重要的其实是{need}。', frame: 'F-NEED', tags: ['warm'] },
    { t: '其实我也在想，关键还是{need}。', frame: 'F-NEED2', tags: ['warm'] }
  ],
  mid: [
    { t: '说到底，我最放不下的还是{need}。', frame: 'F-NEED3', tags: ['warm'] },
    { t: '我也在掂量，真正要紧的是{need}。', frame: 'F-NEED4', tags: ['warm'] }
  ],
  high: [
    { t: '你最在意的，我也想认真接住：{need}。', frame: 'F-NEED5', tags: ['deescalate'] },
    { t: '这份{need}，我记在心里了。', frame: 'F-NEED6', tags: ['warm'] }
  ],
  evidence: [
    { t: '你提到的依据里，最让我信服的是{evidence}。', frame: 'F-EVIDENCE', tags: ['evidence'] },
    { t: '你拿出的{evidence}，我没法当作没看见。', frame: 'F-EVIDENCE2', tags: ['evidence'] }
  ],
  hurt: [
    { t: '说到底，我最放不下的还是{need}（对事不对人）。', frame: 'F-NEED-H', tags: ['dehurt'] },
    { t: '我担心的不是你这个人，是{need}这件具体的事。', frame: 'F-NEED-H2', tags: ['dehurt'] }
  ]
};
const S4_POOL = {
  low: [
    { t: '要不要{action}？', frame: 'F-ASK', tags: ['warm'] },
    { t: '咱们试试{action}？', frame: 'F-TRY', tags: ['warm'] }
  ],
  mid: [
    { t: '要不我们{action}，一起看看{focus}？', frame: 'F-TOGETHER', tags: ['warm'] },
    { t: '不如{action}，顺便把{focus}摊开说？', frame: 'F-TOGETHER2', tags: ['warm'] }
  ],
  high: [
    { t: '要不咱先都缓一缓，再把{focus}一条一条摆开？', frame: 'F-COOLDOWN', tags: ['deescalate'] },
    { t: '先喘口气，{focus}的事我们慢慢来。', frame: 'F-COOLDOWN2', tags: ['deescalate'] }
  ],
  cold: [
    { t: '我想认真跟你说清楚：{need}。', frame: 'F-SERIOUS', tags: ['cold'] },
    { t: '这件事我想郑重跟你谈：{need}。', frame: 'F-SERIOUS2', tags: ['cold'] }
  ],
  concede: [
    { t: '既然你愿意各退一步，那我就陪你把{focus}好好谈清楚。', frame: 'F-CONCEDE', tags: ['concession'] },
    { t: '你肯退一步，我也退一步，我们一起看{focus}。', frame: 'F-CONCEDE2', tags: ['concession'] }
  ],
  negotiable: [
    { t: '但边界可以谈——{focus}。', frame: 'F-NEGOTIATE', tags: ['warm'] },
    { t: '不过哪条能商量，我们可以一条条聊：{focus}。', frame: 'F-NEGOTIATE2', tags: ['warm'] }
  ]
};

/* ---- 槽位抽取（从模板文字提取 {name} 列表）---- */
function slotsOf(tpl) {
  const out = [];
  const re = /\{([a-zA-Z_]+)\}/g;
  let m;
  while ((m = re.exec(tpl)) !== null) out.push(m[1]);
  return out;
}

/* ---- 构建 entries[] ---- */
function buildEntries() {
  const entries = [];
  for (const row of CORPUS_ROWS) {
    const [raw, direction, axis, band, request_category, empathy] = row;
    const key = `${direction}:${axis}`;
    const meta = DIR_AXIS[direction][axis];
    const pos = entries.filter(e => e.group_key === `g-${direction[0] === 'c' ? 'c' : 'p'}-${axis}`).length % 4;
    const groupKey = `g-${direction[0] === 'c' ? 'c' : 'p'}-${axis}-${Math.floor(entries.filter(e => e.direction === direction && e.axis === axis).length / 4)}`;
    const idx = entries.filter(e => e.direction === direction && e.axis === axis).length; // 0..11 within (dir,axis)
    const bandPos = idx % 4; // 0..3 within band
    const id = `G-${direction[0] === 'c' ? 'c' : 'p'}${axis}-${band}-${bandPos + 1}`;
    entries.push({
      id,
      group_key: `g-${direction[0] === 'c' ? 'c' : 'p'}-${axis}-${bandPos}`,
      direction,
      axis,
      intent: meta.intent,
      concern: meta.concern,
      anchor: meta.anchor,
      raw_text: raw,
      band,
      intensity: null,          // 由 analyze() 在运行时推导（与 §1.2 同档），此处留 null 仅作占位
      hurt: null,
      aggression: null,
      hurt_target: null,
      request_category,
      hit_features: [],
      empathy_points: [empathy],
      slots: Object.assign({}, DEFAULT_SLOTS[key]),
      applies_when: { direction, axis, band },
      dehurt_blacklist: [],
      provenance: 'user-research corpus (模拟家庭对话)'
    });
  }
  return entries;
}

/* ---- 构建 variants[]（确定性，无随机）---- */
function buildVariants() {
  const variants = [];
  const dirs = ['child_to_parent', 'parent_to_child'];
  const axes = ['A', 'B', 'C', 'D', 'E'];
  const bands = ['low', 'mid', 'high'];
  let n = 0;
  const add = (v) => { v.id = 'V-' + (++n); variants.push(v); };

  // S2：按 (方向, 轴, 强度档) 建 ≥2 条；hurt 专用档（axis='*'）
  for (const d of dirs) for (const a of axes) for (const b of bands) {
    for (const tpl of S2_POOL[b]) {
      add({
        group_key: `g-${d[0] === 'c' ? 'c' : 'p'}-${a}`, segment: 'S2', direction: d, axis: a, band: b,
        template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
        applies_when: { band: [b], hurt: [0, 1, 2], concession: [0], certainty: [0, 1, 2] },
        style_tags: tpl.tags, weight: 1.0
      });
    }
  }
  for (const d of dirs) for (const tpl of S2_POOL.hurt) {
    add({
      group_key: 'g-*', segment: 'S2', direction: d, axis: '*', band: '*',
      template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
      applies_when: { hurt: [3, 4, 5] }, style_tags: tpl.tags, weight: 1.0
    });
  }

  // S3：按 (方向, 轴, 强度档) 建 ≥2 条；evidence / hurt 专用档
  for (const d of dirs) for (const a of axes) for (const b of bands) {
    for (const tpl of S3_POOL[b]) {
      add({
        group_key: `g-${d[0] === 'c' ? 'c' : 'p'}-${a}`, segment: 'S3', direction: d, axis: a, band: b,
        template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
        applies_when: { band: [b], hurt: [0, 1, 2], rationality: [0, 1], concession: [0], certainty: [0, 1, 2] },
        style_tags: tpl.tags, weight: 1.0
      });
    }
  }
  for (const d of dirs) for (const tpl of S3_POOL.evidence) {
    add({
      group_key: 'g-*', segment: 'S3', direction: d, axis: '*', band: '*',
      template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
      applies_when: { rationality: [2, 3] }, style_tags: tpl.tags, weight: 1.0
    });
  }
  for (const d of dirs) for (const tpl of S3_POOL.hurt) {
    add({
      group_key: 'g-*', segment: 'S3', direction: d, axis: '*', band: '*',
      template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
      applies_when: { hurt: [3, 4, 5] }, style_tags: tpl.tags, weight: 1.0
    });
  }

  // S4：按 (方向, 轴, 强度档) 建 ≥2 条；cold / concede / negotiable 专用档
  for (const d of dirs) for (const a of axes) for (const b of bands) {
    for (const tpl of S4_POOL[b]) {
      add({
        group_key: `g-${d[0] === 'c' ? 'c' : 'p'}-${a}`, segment: 'S4', direction: d, axis: a, band: b,
        template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
        applies_when: { band: [b], hurt: [0, 1, 2], concession: [0], certainty: [0, 1, 2] },
        style_tags: tpl.tags, weight: 1.0
      });
    }
  }
  for (const d of dirs) for (const tpl of S4_POOL.cold) {
    add({
      group_key: 'g-*', segment: 'S4', direction: d, axis: '*', band: '*',
      template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
      applies_when: { hurt: [3, 4, 5] }, style_tags: tpl.tags, weight: 1.0
    });
  }
  for (const d of dirs) for (const tpl of S4_POOL.concede) {
    add({
      group_key: 'g-*', segment: 'S4', direction: d, axis: '*', band: '*',
      template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
      applies_when: { concession: [1, 2] }, style_tags: tpl.tags, weight: 1.0
    });
  }
  for (const d of dirs) for (const tpl of S4_POOL.negotiable) {
    add({
      group_key: 'g-*', segment: 'S4', direction: d, axis: '*', band: '*',
      template: tpl.t, slots: slotsOf(tpl.t), frame_id: tpl.frame,
      applies_when: { certainty: [3] }, style_tags: tpl.tags, weight: 1.0
    });
  }
  return variants;
}

/* ---- 槽位目录（§3.4 镜像）---- */
const SLOT_CATALOG = {
  quote: { source: 'entry.raw_text 前 80 字', desc: 'S1 保真引用' },
  emotion: { source: 'fv.emotion_class', desc: 'S2 情绪槽' },
  emotion2: { source: '对侧默认情绪', desc: 'S2 双承认' },
  feeling: { source: 'entry.slots', desc: 'S2 感受' },
  need: { source: 'entry.slots', desc: 'S3 需要' },
  action: { source: 'entry.slots', desc: 'S4 提议' },
  focus: { source: 'entry.slots', desc: '核心关注点' },
  anchor_label: { source: 'dim_common_anchor.label', desc: '锚点短语' },
  evidence: { source: 'fv.evidence[*].text', desc: '依据引用' },
  concession_phrase: { source: 'fv.concession 命中原文', desc: 'M7 让步行' },
  reciprocal_action: { source: 'entry.slots.reciprocal', desc: 'M7 对等回报' },
  negotiables: { source: 'entry.slots.negotiables', desc: 'M8 可谈判边界' }
};

/* ---- lexicons 镜像（供校验脚本比对；analyze 用的完整词典在 emotionEngine.js）---- */
const LEXICONS = {
  degree_strong: ['简直', '根本', '完全', '彻底', '极度', '极其', '死活', '压根'],
  degree_weak: ['很', '太', '特别', '真的', '真是', '挺', '好', '满', '蛮', '肯定', '一定'],
  absolutizers: ['从来', '从来不', '永远', '所有', '全是', '每次都', '每一次', '绝对', '根本不', '压根', '一点也不', '毫无', '任何时候', '总是'],
  emotion_heavy: [{ w: '烦死了', cls: '愤怒' }, { w: '崩溃', cls: '焦虑' }, { w: '绝望', cls: '伤心' }],
  emotion_light: [{ w: '烦', cls: '愤怒' }, { w: '失望', cls: '失望' }],
  hurt_H1: ['不孝', '没良心', '你算什么东西', '没教养', '家门不幸', '丢尽了脸'],
  hurt_H2: ['没出息', '有什么出息', '出息', '你懂什么', '你有什么资格', '轮得到你', '不是这块料', '就你这样', '注定不行', '干不成事', '白读书', '读了也白读', '指望不上', '没用', '差劲', '不懂事'],
  hurt_H3: ['丢人', '丢脸', '说出去', '别人怎么看', '被人笑话', '低人一等', '抬不起头', '见不得人'],
  hurt_H4: ['将来别怪', '别怪我们', '别怨', '到时候别', '可别怪', '别怪', '你想想我们', '对得起我们吗'],
  imperative: ['必须', '只能', '就得', '给我', '不准', '不许', '免谈', '没得商量', '别讨价还价', '闭嘴', '少来', '听我的'],
  hostile: ['你试试', '信不信', '少废话', '轮不到你', '别装', '轮得到你', '你管得着'],
  certainty_3: ['必须', '就是', '只能', '非得', '一定要', '没得商量', '免谈', '不准', '不许'],
  concession_2: ['各退一步', '各让一步', '我先听你说', '折中', '我们谈条件']
};

/* ---- 组装 corpus 对象（require 时构建，无 IO）---- */
const corpus = {
  schema_version: '1.0.0',
  engine: 'emotion@1.0.0',
  generated_from: 'user-researcher corpus (方向×5轴×3强度档×诉求类别)',
  lexicons: LEXICONS,
  entries: buildEntries(),
  variants: buildVariants(),
  slot_catalog: SLOT_CATALOG,
  anchor_labels: ANCHOR_LABELS,
  default_slots: DEFAULT_SLOTS
};

/* ---- 覆盖矩阵核对（供自证脚本调用，不抛错，返回报告）---- */
function buildCoverageReport() {
  const combos = {};
  for (const e of corpus.entries) {
    const k = `${e.direction}|${e.axis}|${e.band}`;
    combos[k] = (combos[k] || 0) + 1;
  }
  const matrix = {};
  let emptyCount = 0;
  const dirs = ['child_to_parent', 'parent_to_child'];
  const axes = ['A', 'B', 'C', 'D', 'E'];
  const bands = ['low', 'mid', 'high'];
  for (const d of dirs) for (const a of axes) for (const b of bands) {
    const k = `${d}|${a}|${b}`;
    const c = combos[k] || 0;
    matrix[k] = c;
    if (c === 0) emptyCount++;
  }
  // 变体格：每 (segment × band) 单元候选数（按方向分别计 axis 专用 + 通用）
  const cellCount = {};
  for (const d of dirs) for (const s of ['S2', 'S3', 'S4']) for (const b of bands) {
    const axisSpecific = corpus.variants.filter(v => v.direction === d && v.segment === s && v.band === b && v.axis !== '*').length;
    const wildcard = corpus.variants.filter(v => v.direction === d && v.segment === s && (v.band === '*' || v.band === b) && v.axis === '*').length;
    cellCount[`${d}|${s}|${b}`] = { axisSpecific, wildcard, total: axisSpecific + wildcard };
  }
  return { totalEntries: corpus.entries.length, matrix, emptyCount, cellCount, totalVariants: corpus.variants.length };
}

module.exports = corpus;
module.exports.ANCHOR_LABELS = ANCHOR_LABELS;
module.exports.DEFAULT_SLOTS = DEFAULT_SLOTS;
module.exports.buildCoverageReport = buildCoverageReport;
