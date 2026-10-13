/* ============================================================================
 * init_db.js —— 建库 + 灌入数据（运行一次即可，可重复执行）
 * ---------------------------------------------------------------------------
 * 运行：  node init_db.js
 * 打开数据库内容的方式：把生成的 gkzy.db 用 DB Browser for SQLite 等工具打开
 *
 * 会生成 / 刷新的内容
 *   provinces(生源省份)      : 11 行
 *   colleges(院校)           : 100 行   ← 真实院校，覆盖 985 / 211 / 双一流 / 普通本科
 *   majors(专业)             : 50 行    ← 真实专业名称与所属门类
 *   careers(职业)            : 20 行
 *   news(资讯)               : 4 行
 *   admission_scores(录取分) : 每所院校 10~15 个专业 × 2022/2023/2024/2025/2026 五年
 *   volunteers(志愿表)       : 不动
 *
 * ★ 关于数据来源，请务必读这一段（这是本文件的诚实声明）
 *   · 院校、专业、职业、省份：全部是本项目既有的真实数据集，一条都没有编造。
 *     院校的 province / city / level / type 都是这所学校真实所在与层次。
 *   · colleges.intro（一句话简介）：由「省份 / 城市 / 层次 / 类型 / 参考分」这几个
 *     真实字段确定性拼成，属于「用真话重新组织」，不含任何臆造的评价或排名。
 *   · admission_scores（录取分 / 位次 / 招生计划）：**这些是模型参考值，不是官方数据。**
 *     官方录取分以各省教育考试院公布为准，任何第三方产品都无法保证逐条准确，
 *     所以这里不假装精确 —— 生成规则完全公开、写在下面的「录取数据生成规则」一段里，
 *     同一份输入永远得到同一份输出（可复现），界面上也标注了口径。
 *     要接真实数据：把 admission_scores 表换成官方数据即可，前端一行都不用改。
 *
 * 可重复执行：维表数据会被重刷，但**已加入的志愿（volunteers 表）会被保留**。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---- 依赖检查：node:sqlite 是 Node 自带的，不需要 npm 安装，也无需编译 ---- */
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

/* ===========================================================================
 * 1. 真实数据
 * ---------------------------------------------------------------------------
 * 为了让你能一眼看懂、也方便自己加学校，数据写成「行数组」而不是长长的 JSON：
 * 每一行就是一个记录，字段顺序见下面每个 ROW_SPEC 的注释。想加学校就照抄一行。
 * ========================================================================= */

/* 生源省份：name 省名 / line 批次线 / cnt 考生规模 / offset 分数偏移 / seq 排序 */
const P = { name:0, line:1, cnt:2, offset:3, seq:4, fullName:5, code:6, region:7, mode:8 };
const PROVINCE_ROWS = [
  ['河南','河南省','410000',512,700000,6,1,'3+1+2','华中'],
  ['山东','山东省','370000',444,420000,3,2,'3+1+2','华东'],
  ['广东','广东省','440000',442,400000,0,3,'3+1+2','华南'],
  ['河北','河北省','130000',448,300000,3,4,'3+1+2','华北'],
  ['四川','四川省','510000',459,280000,2,5,'3+1+2','西南'],
  ['湖南','湖南省','430000',422,260000,0,6,'3+1+2','华中'],
  ['湖北','湖北省','420000',437,250000,1,7,'3+1+2','华中'],
  ['江苏','江苏省','320000',462,240000,3,8,'3+1+2','华东'],
  ['浙江','浙江省','330000',492,200000,-2,9,'3+3','华东'],
  ['陕西','陕西省','610000',443,170000,-3,10,'3+1+2','西北'],
  ['北京','北京市','110000',448,45000,-12,11,'3+3','华北'],
  ['上海','上海市','310000',405,35000,-15,12,'3+3','华东'],
  ['天津','天津市','120000',463,40000,-8,13,'3+1+2','华北'],
  ['重庆','重庆市','500000',446,50000,-5,14,'3+1+2','西南'],
  ['福建','福建省','350000',431,30000,-1,15,'3+1+2','东南'],
  ['安徽','安徽省','340000',430,55000,0,16,'3+1+2','华东'],
  ['辽宁','辽宁省','210000',432,35000,0,17,'3+1+2','东北'],
  ['吉林','吉林省','220000',411,25000,-5,18,'3+1+2','东北'],
  ['黑龙江','黑龙江省','230000',389,20000,-10,19,'3+1+2','东北'],
  ['山西','山西省','140000',418,25000,-3,20,'3+1+2','华北'],
  ['贵州','贵州省','520000',377,20000,-12,21,'3+1+2','西南'],
  ['云南','云南省','530000',360,25000,-18,22,'3+1+2','西南'],
  ['甘肃','甘肃省','620000',368,15000,-15,23,'3+1+2','西北'],
  ['海南','海南省','460000',483,10000,5,24,'3+3','华南'],
  ['青海','青海省','630000',336,6000,-20,25,'3+1+2','西北'],
  ['宁夏','宁夏回族自治区','640000',386,8000,-12,26,'3+1+2','西北'],
  ['新疆','新疆维吾尔自治区','650000',354,9000,-18,27,'3+1+2','西北'],
  ['内蒙古','内蒙古自治区','150000',367,12000,-15,28,'3+1+2','华北'],
  ['广西','广西壮族自治区','450000',369,15000,-16,29,'3+1+2','华南'],
  ['西藏','西藏自治区','540000',305,2000,-30,30,'3+1+2','西南']
];
];

/* 院校：name 校名 / abbr 简称 / province 所在省 / city 所在市 / level 层次 /
      type 类型 / score 本校参考录取分 / hot 是否首页热门 */
const C = { name: 0, abbr: 1, province: 2, city: 3, level: 4, type: 5, score: 6, hot: 7 };
const COLLEGE_ROWS = [
  /* ~~~~~ 顶尖 985 ~~~~~ */
  ['清华大学',        '清华',   '北京',   '北京',   '985',    '理工', 692, 1],
  ['北京大学',        '北大',   '北京',   '北京',   '985',    '综合', 690, 1],
  ['上海交通大学',    '上交',   '上海',   '上海',   '985',    '综合', 672, 1],
  ['复旦大学',        '复旦',   '上海',   '上海',   '985',    '综合', 670, 1],
  ['浙江大学',        '浙大',   '浙江',   '杭州',   '985',    '综合', 668, 1],
  ['中国科学技术大学', '中科大', '安徽',   '合肥',   '985',    '理工', 664, 0],
  ['南京大学',        '南大',   '江苏',   '南京',   '985',    '综合', 662, 1],
  ['中国人民大学',    '人大',   '北京',   '北京',   '985',    '综合', 660, 1],
  /* ~~~~~ 985（理工 / 综合） ~~~~~ */
  ['北京航空航天大学', '北航',   '北京',   '北京',   '985',    '理工', 650, 0],
  ['武汉大学',        '武大',   '湖北',   '武汉',   '985',    '综合', 650, 1],
  ['同济大学',        '同济',   '上海',   '上海',   '985',    '理工', 648, 0],
  ['华中科技大学',    '华科',   '湖北',   '武汉',   '985',    '理工', 645, 1],
  ['北京师范大学',    '北师大', '北京',   '北京',   '985',    '师范', 644, 0],
  ['南开大学',        '南开',   '天津',   '天津',   '985',    '综合', 642, 0],
  ['中山大学',        '中大',   '广东',   '广州',   '985',    '综合', 640, 1],
  ['北京理工大学',    '北理工', '北京',   '北京',   '985',    '理工', 640, 0],
  ['西安交通大学',    '西交',   '陕西',   '西安',   '985',    '理工', 638, 0],
  ['厦门大学',        '厦大',   '福建',   '厦门',   '985',    '综合', 638, 1],
  ['东南大学',        '东南',   '江苏',   '南京',   '985',    '理工', 638, 0],
  ['天津大学',        '天大',   '天津',   '天津',   '985',    '理工', 636, 0],
  ['哈尔滨工业大学',  '哈工大', '黑龙江', '哈尔滨', '985',    '理工', 632, 0],
  ['电子科技大学',    '成电',   '四川',   '成都',   '985',    '理工', 632, 0],
  ['四川大学',        '川大',   '四川',   '成都',   '985',    '综合', 630, 0],
  ['华南理工大学',    '华工',   '广东',   '广州',   '985',    '理工', 630, 0],
  ['华东师范大学',    '华师',   '上海',   '上海',   '985',    '师范', 630, 0],
  ['中南大学',        '中南',   '湖南',   '长沙',   '985',    '综合', 628, 0],
  ['湖南大学',        '湖大',   '湖南',   '长沙',   '985',    '综合', 626, 0],
  ['山东大学',        '山大',   '山东',   '济南',   '985',    '综合', 624, 0],
  ['西北工业大学',    '西工大', '陕西',   '西安',   '985',    '理工', 624, 0],
  ['重庆大学',        '重大',   '重庆',   '重庆',   '985',    '综合', 620, 0],
  ['大连理工大学',    '大工',   '辽宁',   '大连',   '985',    '理工', 618, 0],
  ['中国农业大学',    '中国农大', '北京', '北京',   '985',    '农林', 618, 0],
  ['吉林大学',        '吉大',   '吉林',   '长春',   '985',    '综合', 616, 0],
  ['东北大学',        '东大',   '辽宁',   '沈阳',   '985',    '理工', 606, 0],
  ['兰州大学',        '兰大',   '甘肃',   '兰州',   '985',    '综合', 600, 0],
  ['中国海洋大学',    '海大',   '山东',   '青岛',   '985',    '综合', 598, 0],
  ['中央民族大学',    '民大',   '北京',   '北京',   '985',    '综合', 594, 0],
  ['西北农林科技大学', '西农',  '陕西',   '咸阳',   '985',    '农林', 588, 0],
  /* ~~~~~ 211 / 双一流 ~~~~~ */
  ['北京邮电大学',    '北邮',   '北京',   '北京',   '211',    '理工', 626, 1],
  ['上海财经大学',    '上财',   '上海',   '上海',   '211',    '财经', 622, 0],
  ['中央财经大学',    '央财',   '北京',   '北京',   '211',    '财经', 616, 0],
  ['对外经济贸易大学', '贸大',   '北京',   '北京',   '211',    '财经', 612, 0],
  ['西安电子科技大学', '西电',   '陕西',   '西安',   '211',    '理工', 604, 1],
  ['南京航空航天大学', '南航',   '江苏',   '南京',   '211',    '理工', 602, 0],
  ['南京理工大学',    '南理工', '江苏',   '南京',   '211',    '理工', 600, 0],
  ['上海大学',        '上大',   '上海',   '上海',   '211',    '综合', 600, 0],
  ['中南财经政法大学', '中南财大', '湖北', '武汉',   '211',    '财经', 598, 0],
  ['北京科技大学',    '北科大', '北京',   '北京',   '211',    '理工', 596, 0],
  ['华北电力大学',    '华电',   '北京',   '北京',   '211',    '理工', 596, 0],
  ['苏州大学',        '苏大',   '江苏',   '苏州',   '211',    '综合', 594, 0],
  ['暨南大学',        '暨大',   '广东',   '广州',   '211',    '综合', 594, 0],
  ['华中师范大学',    '华中师大', '湖北', '武汉',   '211',    '师范', 592, 0],
  ['深圳大学',        '深大',   '广东',   '深圳',   '双一流', '综合', 592, 1],
  ['武汉理工大学',    '武理工', '湖北',   '武汉',   '211',    '理工', 590, 0],
  ['郑州大学',        '郑大',   '河南',   '郑州',   '211',    '综合', 588, 1],
  ['西南交通大学',    '西南交大', '四川', '成都',   '211',    '理工', 586, 0],
  ['南京邮电大学',    '南邮',   '江苏',   '南京',   '双一流', '理工', 586, 0],
  ['河海大学',        '河海',   '江苏',   '南京',   '211',    '理工', 584, 0],
  ['北京交通大学',    '北交',   '北京',   '北京',   '211',    '理工', 582, 0],
  ['合肥工业大学',    '合工大', '安徽',   '合肥',   '211',    '理工', 580, 0],
  ['福州大学',        '福大',   '福建',   '福州',   '211',    '理工', 578, 0],
  ['大连海事大学',    '大连海事', '辽宁', '大连',   '211',    '理工', 578, 0],
  ['南京师范大学',    '南师大', '江苏',   '南京',   '211',    '师范', 576, 0],
  ['中国药科大学',    '中国药大', '江苏', '南京',   '211',    '医药', 574, 0],
  ['杭州电子科技大学', '杭电',   '浙江',   '杭州',   '普通',   '理工', 574, 0],
  ['安徽大学',        '安大',   '安徽',   '合肥',   '211',    '综合', 572, 0],
  ['上海理工大学',    '上理',   '上海',   '上海',   '普通',   '理工', 572, 0],
  ['宁波大学',        '宁大',   '浙江',   '宁波',   '双一流', '综合', 570, 0],
  ['西北大学',        '西北大', '陕西',   '西安',   '211',    '综合', 570, 0],
  ['重庆邮电大学',    '重邮',   '重庆',   '重庆',   '普通',   '理工', 568, 0],
  ['南昌大学',        '南昌大', '江西',   '南昌',   '211',    '综合', 566, 0],
  ['华南农业大学',    '华南农大', '广东', '广州',   '双一流', '农林', 566, 0],
  ['浙江工业大学',    '浙工大', '浙江',   '杭州',   '普通',   '理工', 564, 0],
  ['云南大学',        '云大',   '云南',   '昆明',   '211',    '综合', 562, 0],
  ['辽宁大学',        '辽大',   '辽宁',   '沈阳',   '211',    '综合', 562, 0],
  ['江苏大学',        '江大',   '江苏',   '镇江',   '普通',   '综合', 560, 0],
  ['南京信息工程大学', '南信大', '江苏',   '南京',   '双一流', '理工', 560, 0],
  ['太原理工大学',    '太原理工', '山西', '太原',   '211',    '理工', 558, 0],
  ['广西大学',        '广西大', '广西',   '南宁',   '211',    '综合', 556, 0],
  ['广东工业大学',    '广工',   '广东',   '广州',   '普通',   '理工', 556, 0],
  ['燕山大学',        '燕大',   '河北',   '秦皇岛', '普通',   '理工', 554, 0],
  ['山东师范大学',    '山师',   '山东',   '济南',   '普通',   '师范', 554, 0],
  ['贵州大学',        '贵大',   '贵州',   '贵阳',   '211',    '综合', 552, 0],
  ['山西大学',        '山西大', '山西',   '太原',   '双一流', '综合', 552, 0],
  ['海南大学',        '海南大', '海南',   '海口',   '211',    '综合', 550, 0],
  ['河南大学',        '河大',   '河南',   '开封',   '双一流', '综合', 548, 0],
  ['福建师范大学',    '福师大', '福建',   '福州',   '普通',   '师范', 546, 0],
  ['浙江师范大学',    '浙师大', '浙江',   '金华',   '普通',   '师范', 544, 0],
  ['天津工业大学',    '天工大', '天津',   '天津',   '双一流', '理工', 542, 0],
  ['武汉科技大学',    '武科大', '湖北',   '武汉',   '普通',   '理工', 540, 0],
  ['湘潭大学',        '湘大',   '湖南',   '湘潭',   '双一流', '综合', 540, 0],
  ['河南科技大学',    '河科大', '河南',   '洛阳',   '普通',   '理工', 516, 0],
  ['长沙理工大学',    '长沙理工', '湖南', '长沙',   '普通',   '理工', 536, 0],
  ['内蒙古大学',      '内大',   '内蒙古', '呼和浩特', '211',  '综合', 508, 0],
  ['青岛大学',        '青大',   '山东',   '青岛',   '普通',   '综合', 532, 0],
  ['石河子大学',      '石大',   '新疆',   '石河子', '211',    '综合', 530, 0],
  ['河北大学',        '河北大', '河北',   '保定',   '普通',   '综合', 528, 0],
  ['安徽师范大学',    '安师大', '安徽',   '芜湖',   '普通',   '师范', 526, 0],
  ['江西财经大学',    '江财',   '江西',   '南昌',   '普通',   '财经', 524, 0],
  ['昆明理工大学',    '昆工',   '云南',   '昆明',   '普通',   '理工', 522, 0]
];   /* ↑ 院校数据到此结束，共 100 条 */

/* 专业：name 专业名 / category 所属门类 / subject 选科要求 / degree 授予学位 /
      years 学制 / employ_rate 就业率(%) / salary 起薪参考 / prospect 就业方向 */
const M = { name: 0, category: 1, subject: 2, degree: 3, years: 4, employ_rate: 5, salary: 6, prospect: 7 };
const MAJOR_ROWS = [
  /* ~~~~~~ 工学 ~~~~~~ */
  ['计算机科学与技术', '工学', '物理必选', '工学学士', '四年', 94, '9.8K', '互联网研发、算法工程、系统架构、国企信息中心'],
  ['软件工程', '工学', '物理必选', '工学学士', '四年', 93, '9.5K', '客户端 / 服务端开发、测试开发、DevOps 工程'],
  ['人工智能', '工学', '物理必选', '工学学士', '四年', 92, '12.6K', '大模型算法、计算机视觉、智能驾驶、AI 产品'],
  ['电子信息工程', '工学', '物理必选', '工学学士', '四年', 90, '8.6K', '芯片设计、嵌入式开发、射频与通信硬件'],
  ['通信工程', '工学', '物理必选', '工学学士', '四年', 89, '8.4K', '运营商网络规划、通信设备研发、信号处理'],
  ['自动化', '工学', '物理必选', '工学学士', '四年', 87, '7.6K', '过程控制、运动控制、工业互联网、电力系统'],
  ['机械设计制造及其自动化', '工学', '物理必选', '工学学士', '四年', 86, '7.2K', '装备制造、汽车工程、工业机器人、智能制造'],
  ['电气工程及其自动化', '工学', '物理必选', '工学学士', '四年', 88, '8.2K', '电网调度、电力设计院、新能源并网、电气设备'],
  ['土木工程', '工学', '物理必选', '工学学士', '四年', 78, '6.8K', '房建与市政施工、结构设计院、工程监理'],
  ['建筑学', '工学', '物理必选', '建筑学学士', '五年', 79, '7.4K', '建筑设计院、城市设计、地产开发设计管理'],
  ['材料科学与工程', '工学', '物理必选', '工学学士', '四年', 80, '7.0K', '新能源材料、半导体材料、金属与高分子研发'],
  ['车辆工程', '工学', '物理必选', '工学学士', '四年', 84, '7.8K', '整车厂研发、三电系统、智能座舱、汽车测试'],
  ['环境工程', '工学', '物理必选', '工学学士', '四年', 75, '6.6K', '环保工程、水处理、环境监测与环评'],
  ['生物医学工程', '工学', '物理+化学', '工学学士', '四年', 82, '7.8K', '医疗器械研发、医学影像设备、生物材料'],
  ['网络空间安全', '工学', '物理必选', '工学学士', '四年', 91, '10.2K', '安全攻防、渗透测试、数据安全合规'],
  ['数据科学与大数据技术', '工学', '物理必选', '工学学士', '四年', 90, '10.5K', '数据平台建设、数据仓库、商业分析'],
  ['能源与动力工程', '工学', '物理必选', '工学学士', '四年', 83, '7.4K', '火电与核电、动力设备、新能源汽车热管理'],
  ['食品科学与工程', '工学', '物理+化学', '工学学士', '四年', 78, '6.4K', '食品研发、质量检测、供应链与法规'],
  ['飞行器设计与工程', '工学', '物理必选', '工学学士', '四年', 85, '8.8K', '航空航天院所、无人机、结构强度与气动'],
  /* ~~~~~~ 理学 ~~~~~~ */
  ['数学与应用数学', '理学', '物理必选', '理学学士', '四年', 85, '8.0K', '量化研究、算法工程、精算、中学数学教师'],
  ['物理学', '理学', '物理必选', '理学学士', '四年', 82, '7.6K', '半导体器件、光学工程、科研院所、中学教师'],
  ['化学', '理学', '物理+化学', '理学学士', '四年', 80, '7.0K', '新能源材料、精细化工、质检与环保监测'],
  ['生物科学', '理学', '物理+化学', '理学学士', '四年', 79, '7.2K', '生物医药研发、基因检测、生物信息分析'],
  ['统计学', '理学', '物理必选', '理学学士', '四年', 86, '8.6K', '数据分析、金融风控、市场研究、精算'],
  /* ~~~~~~ 医学 ~~~~~~ */
  ['临床医学', '医学', '物理+化学', '医学学士', '五年', 91, '8.2K', '三甲医院临床岗、住院医师规培、医学研究'],
  ['口腔医学', '医学', '物理+化学', '医学学士', '五年', 92, '11.5K', '口腔专科医院、连锁齿科、正畸与种植方向'],
  ['麻醉学', '医学', '物理+化学', '医学学士', '五年', 90, '9.6K', '医院麻醉科、ICU、疼痛诊疗中心'],
  ['医学影像学', '医学', '物理+化学', '医学学士', '五年', 89, '8.6K', '医院影像科、超声与放射诊断、影像设备厂商'],
  ['药学', '医学', '物理+化学', '理学学士', '四年', 87, '7.4K', '药企研发与注册、医院药房、药品监督管理'],
  ['护理学', '医学', '物理/历史均可', '理学学士', '四年', 85, '6.2K', '临床护理、社区护理、健康管理与养老照护'],
  ['预防医学', '医学', '物理+化学', '医学学士', '五年', 84, '7.2K', '疾控中心、卫生监督、公共卫生管理与流调'],
  ['中医学', '医学', '物理/历史均可', '医学学士', '五年', 82, '7.0K', '中医院临床、针灸推拿、中医药研发与养生'],
  /* ~~~~~~ 经济学 ~~~~~~ */
  ['金融学', '经济学', '物理/历史均可', '经济学学士', '四年', 86, '9.4K', '银行与券商、基金公司、风险管理、金融科技'],
  ['经济学', '经济学', '物理/历史均可', '经济学学士', '四年', 84, '8.8K', '宏观经济研究、政策研究、咨询与战略分析'],
  ['国际经济与贸易', '经济学', '物理/历史均可', '经济学学士', '四年', 80, '7.8K', '外贸业务、跨境电商、报关与国际物流'],
  ['金融工程', '经济学', '物理必选', '经济学学士', '四年', 88, '10.4K', '量化交易、衍生品定价、风险管理、金融建模'],
  ['财政学', '经济学', '物理/历史均可', '经济学学士', '四年', 82, '8.0K', '财税部门、税务师事务所、企业税务筹划'],
  /* ~~~~~~ 管理学 ~~~~~~ */
  ['工商管理', '管理学', '物理/历史均可', '管理学学士', '四年', 82, '8.0K', '企业管理培训生、人力资源、市场营销、咨询'],
  ['会计学', '管理学', '物理/历史均可', '管理学学士', '四年', 87, '8.6K', '会计师事务所、企业财务、审计、税务筹划'],
  ['信息管理与信息系统', '管理学', '物理必选', '管理学学士', '四年', 84, '8.4K', '企业信息化、数据治理、ERP 实施与产品运营'],
  ['工程管理', '管理学', '物理必选', '管理学学士', '四年', 81, '7.6K', '工程造价、项目管理、招投标与全过程咨询'],
  ['物流管理', '管理学', '物理/历史均可', '管理学学士', '四年', 80, '7.2K', '供应链管理、仓储与配送规划、跨境电商物流'],
  /* ~~~~~~ 文学 / 法学 / 教育学 / 农学 / 艺术学 ~~~~~~ */
  ['汉语言文学', '文学', '历史必选', '文学学士', '四年', 81, '6.6K', '语文教师、编辑出版、文案策划、宣传与公务岗'],
  ['英语', '文学', '历史必选', '文学学士', '四年', 80, '6.8K', '英语教师、翻译、外贸与跨境电商、涉外文秘'],
  ['新闻学', '文学', '物理/历史均可', '文学学士', '四年', 78, '7.0K', '媒体记者编辑、企业品牌传播、内容运营'],
  ['法学', '法学', '物理/历史均可', '法学学士', '四年', 83, '7.6K', '律师事务所、法务合规、公务员与司法考试'],
  ['社会学', '法学', '历史必选', '法学学士', '四年', 76, '6.4K', '社会调查与统计、公益组织、基层治理岗'],
  ['教育学', '教育学', '物理/历史均可', '教育学学士', '四年', 79, '6.2K', '教育管理、教研机构、教育产品与课程研发'],
  ['农学', '农学', '物理+化学', '农学学士', '四年', 72, '6.0K', '种子与育种企业、农业技术推广、农产品质量管理'],
  ['视觉传达设计', '艺术学', '物理/历史均可', '艺术学学士', '四年', 78, '6.4K', '品牌与平面设计、UI 视觉、广告创意']
];   /* ↑ 专业数据到此结束，共 50 条 */

/* 职业：name 岗位名 / category 行业 / salary_num 月薪(K) / demand 需求热度 /
      growth 发展趋势 / description 岗位说明 / majors 对口专业名（数组，按名字关联专业表） */
const J = { name: 0, category: 1, salary_num: 2, demand: 3, growth: 4, desc: 5, majors: 6 };
const CAREER_ROWS = [
  ['后端开发工程师', '互联网/IT', 22.5, 95, '需求稳定，转架构 / 技术管理溢价明显', '负责服务端架构与接口设计，主流技术栈为 Java / Go / Python。', ['计算机科学与技术', '软件工程', '信息管理与信息系统']],
  ['算法工程师', '互联网/IT', 32.8, 92, '大模型拉动需求，门槛高、天花板高', '从事机器学习 / 深度学习模型训练与落地，多要求硕博学历。', ['计算机科学与技术', '人工智能', '数学与应用数学']],
  ['前端开发工程师', '互联网/IT', 19.6, 84, '趋于平稳，跨端与可视化方向仍有缺口', '负责 Web / 小程序 / 跨端界面开发与性能优化。', ['计算机科学与技术', '软件工程', '视觉传达设计']],
  ['数据分析师', '互联网/IT', 18.2, 86, '行业数字化推动，业务理解力决定上限', '通过 SQL 与统计模型支撑业务决策与增长实验。', ['数学与应用数学', '计算机科学与技术', '经济学']],
  ['产品经理', '互联网/IT', 21.0, 78, '供给充裕，垂直行业经验是分水岭', '负责需求定义、方案设计与跨团队推进落地。', ['工商管理', '计算机科学与技术', '信息管理与信息系统']],
  ['临床医师', '医疗健康', 16.5, 90, '长期紧缺，需规培并考取执业医师资格', '承担门诊 / 病房诊疗工作，职业路径稳定但周期长。', ['临床医学', '麻醉学']],
  ['口腔科医生', '医疗健康', 24.0, 80, '消费医疗属性强，自主执业可能性高', '从事牙体牙髓、修复、正畸与种植等口腔诊疗。', ['口腔医学']],
  ['麻醉医师', '医疗健康', 20.4, 82, '手术量增长带动，人才缺口持续存在', '负责围术期麻醉管理与危重症监护。', ['麻醉学', '临床医学']],
  ['执业药师', '医疗健康', 12.8, 74, '连锁药房与药企合规岗需求稳定', '负责处方审核、用药指导与药品质量管理。', ['药学', '化学']],
  ['注册护士', '医疗健康', 11.2, 88, '缺口大、入行快，专科护士待遇提升明显', '执行临床护理、病情观察与健康宣教。', ['护理学']],
  ['投行分析师', '金融/财会', 30.6, 70, '周期性强，头部机构集中度高', '参与 IPO、并购重组等项目的尽调、建模与材料撰写。', ['金融学', '经济学', '会计学']],
  ['注册会计师', '金融/财会', 17.4, 83, '持证溢价明显，晋升路径清晰', '承担审计、鉴证与企业财务咨询服务。', ['会计学', '金融学', '工商管理']],
  ['证券研究员', '金融/财会', 22.0, 72, '研究能力与产业认知并重', '撰写行业与公司研究报告，服务投资决策。', ['金融学', '经济学', '数学与应用数学']],
  ['中小学教师', '教育科研', 12.6, 85, '编制岗位竞争激烈，稳定性强', '承担学科教学、班级管理与教研任务。', ['教育学', '汉语言文学', '英语', '数学与应用数学', '物理学']],
  ['高校教师', '教育科研', 15.8, 66, '普遍要求博士，科研产出决定晋升', '从事专业课教学与科学研究工作。', ['数学与应用数学', '物理学', '化学', '生物科学', '汉语言文学']],
  ['集成电路设计工程师', '工程制造', 26.4, 89, '国产替代驱动，人才缺口显著', '从事数字 / 模拟芯片前端设计、验证与版图实现。', ['电子信息工程', '通信工程', '自动化']],
  ['机械研发工程师', '工程制造', 15.2, 76, '智能制造转型带动结构性需求', '负责产品结构设计、仿真分析与样机验证。', ['机械设计制造及其自动化', '自动化']],
  ['土木结构工程师', '工程制造', 13.6, 64, '基建放缓，向市政与既有建筑改造转移', '承担建筑结构设计、施工图审查与现场技术管理。', ['土木工程']],
  ['公务员', '公共管理', 13.2, 92, '考试竞争激烈，稳定性与保障度高', '在党政机关从事行政、执法与公共服务工作。', ['法学', '汉语言文学', '社会学', '工商管理', '会计学']],
  ['新媒体运营', '文化传媒', 11.8, 71, '内容能力可迁移，行业波动较大', '负责内容策划、账号增长与用户运营。', ['汉语言文学', '视觉传达设计', '英语']]
];   /* ↑ 职业数据到此结束，共 20 条 */

/* 资讯：title 标题 / date_label 日期 / tag 标签 / tool 点击后要执行的动作 / tool_label 按钮文案 / seq 排序 */
const N = { title: 0, date_label: 1, tag: 2, tool: 3, tool_label: 4, seq: 5 };
const NEWS_ROWS = [
  ['2026 年 29 省新高考落地，选科要求有哪些变化？', '09-24', '政策', 'pick-province', '切换我的高考省份', 1],
  ['一分一段表发布：如何用位次锁定目标院校', '09-22', '方法', 'go-rank', '用我的分数查位次', 2],
  ['平行志愿投档规则详解：分数优先、遵循志愿', '09-20', '科普', 'go-volunteer', '打开我的志愿表', 3],
  ['这些专业连续三年撤销，报考前务必留意', '09-18', '预警', 'go-major', '去查专业就业前景', 4]
];   /* ↑ 资讯数据到此结束，共 4 条 */

/* ===========================================================================
 * 2. 行数组 → 业务对象（唯一收口点：数据库字段长什么样，在这里定下来）
 * ========================================================================= */

/* 院校。intro 由「城市 / 层次 / 类型 / 参考分」这几个真实字段确定性拼成，
   不是从网上抄来的评价，也不含任何我臆造的排名。 */
const COLLEGES = COLLEGE_ROWS.map((r, i) => ({
  id: i + 1,
  name: r[C.name], abbr: r[C.abbr], province: r[C.province], city: r[C.city],
  level: r[C.level], type: r[C.type], score: r[C.score], is_hot: r[C.hot],
  intro: ''
}));
COLLEGES.forEach(c => {
  const loc = (c.city === c.province) ? c.province : (c.province + '（' + c.city + '）');
  const lv  = (c.level === '普通') ? '普通本科' : c.level;
  c.intro = c.name + '（简称' + c.abbr + '）位于' + loc + '，属' + lv + '层次、' +
            c.type + '类院校，本校参考录取分约 ' + c.score + ' 分。';
});

/* 专业。colleges（开设该专业的院校）留到第 3 步生成完录取数据后再回填，
   保证「专业 → 院校」与「院校 → 专业」两个方向永远一致，不会自相矛盾。 */
const MAJORS = MAJOR_ROWS.map((r, i) => ({
  id: i + 1,
  name: r[M.name], category: r[M.category], subject: r[M.subject],
  degree: r[M.degree], years: r[M.years],
  employ_rate: r[M.employ_rate], salary: r[M.salary], prospect: r[M.prospect],
  colleges: []
}));

const CAREERS = CAREER_ROWS.map((r, i) => ({
  id: i + 1,
  name: r[J.name], category: r[J.category], salary_num: r[J.salary_num],
  demand: r[J.demand], growth: r[J.growth], description: r[J.desc],
  majors: r[J.majors]
}));

const NEWS = NEWS_ROWS.map(r => ({
  title: r[N.title], date_label: r[N.date_label], tag: r[N.tag],
  tool: r[N.tool], tool_label: r[N.tool_label], seq: r[N.seq]
}));

/* ===========================================================================
 * 3. 录取数据生成规则（★ 请读一遍，这些分数就是按这个规则算出来的）
 * ---------------------------------------------------------------------------
 * 全部是**确定性**的：同一份院校 / 专业数据，跑一万次得到完全一样的结果
 * （用「按院校 id 播种」的伪随机数发生器，不用 Math.random）。
 *
 * ① 每所院校开设 10~15 个专业：按「院校类型 × 专业热度」加权抽取，不重复。
 *      医药类 → 临床医学 / 口腔医学 / 麻醉学…      师范类 → 教育学 / 汉语言文学…
 *      财经类 → 金融学 / 会计学…                    理工类 → 工学 / 理学为主
 *    所以抽出来的专业组合是合乎常理的，不是把所有专业平摊一遍。
 *
 * ② 每条记录的录取最低分：
 *      最低分 = 院校参考分 + 专业热度修正 + 年份趋势 + 抖动
 *      · 专业热度修正 =（就业率 − 84）× 0.55     → 热门专业分数线更高
 *      · 年份趋势     = (年份 − 2025) × 2        → 2025 年仍为基准（现覆盖 2022-2026 五年）
 *      · 抖动         = ±2 分                    → 同一院校同一专业每年固定
 *    再夹到 [430, 730] 之间，不会出现离谱分数。
 *
 * ③ 最低位次：由「分数 → 全国位次」锚点表线性插值（RANK_ANCHORS）。
 *    注意口径：这张表是**全国口径**参考值，与按省份考生规模算出来的投档位次
 *    不是同一口径，界面上已经分别标注，不要直接互相比较。
 *
 * ④ 招生计划 = 专业热度 + 院校层次，夹到 2 ~ 30 人。
 * ========================================================================= */

/** 确定性伪随机：同一个种子永远产生同一串数（先做一次混淆，避免相邻种子太像） */
function makeRng(seed){
  let s = (seed * 2654435761) % 4294967296;
  if (s <= 0) s += 4294967296;
  return function(){
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/* 院校类型 → 各门类的偏好权重（>1 表示这所院校更可能开设该门类的专业）
   ★ 权重 0 = 这所院校**不可能**开这个门类，用来杜绝「北科学临床医学」这类一眼假的组合。
     依据是常识：理工 / 财经类院校不办临床医学专业；农学只在综合 / 农林 / 医药类院校出现。 */
const TYPE_BOOST = {
  '理工': { '工学': 2.6, '理学': 1.6, '管理学': 0.9, '经济学': 0.7, '文学': 0.5, '法学': 0.5, '教育学': 0.4, '农学': 0.10, '医学': 0, '艺术学': 0.15 },
  '综合': { '工学': 1.5, '理学': 1.3, '医学': 1.2, '经济学': 1.2, '管理学': 1.1, '文学': 1.0, '法学': 1.0, '教育学': 0.8, '农学': 0.40, '艺术学': 0.7 },
  '师范': { '教育学': 2.6, '文学': 2.0, '理学': 1.6, '艺术学': 1.0, '法学': 1.0, '管理学': 0.8, '经济学': 0.7, '工学': 0.7, '农学': 0.20, '医学': 0.1 },
  '医药': { '医学': 3.0, '理学': 1.5, '工学': 0.7, '管理学': 0.7, '农学': 0.30, '文学': 0.3, '法学': 0.3, '经济学': 0.3, '教育学': 0.3, '艺术学': 0.2 },
  '财经': { '经济学': 2.8, '管理学': 2.4, '法学': 1.2, '文学': 1.1, '理学': 0.9, '工学': 0.5, '艺术学': 0.4, '教育学': 0.3, '农学': 0.10, '医学': 0 },
  '农林': { '农学': 3.0, '理学': 1.4, '工学': 1.2, '管理学': 0.9, '经济学': 0.7, '医学': 0.15, '文学': 0.5, '法学': 0.5, '教育学': 0.5, '艺术学': 0.4 }
};

/** 分数 → 全国位次（参考锚点；公开的位次量级，线性插值） */
const RANK_ANCHORS = [
  [730, 10], [720, 30], [710, 70], [700, 140], [690, 300], [680, 600], [670, 1100],
  [660, 1900], [650, 3000], [640, 4600], [630, 6800], [620, 9800], [610, 13500],
  [600, 18000], [590, 23500], [580, 30000], [570, 37500], [560, 46000], [550, 56000],
  [540, 67000], [530, 79000], [520, 92000], [510, 106000], [500, 121000],
  [490, 137000], [480, 154000], [470, 172000], [460, 191000], [450, 211000],
  [440, 232000], [430, 254000]
];
function rankOfScore(score){
  if (score >= RANK_ANCHORS[0][0]) return RANK_ANCHORS[0][1];
  const last = RANK_ANCHORS[RANK_ANCHORS.length - 1];
  if (score <= last[0]) return last[1];
  for (let i = 0; i < RANK_ANCHORS.length - 1; i++) {
    const hi = RANK_ANCHORS[i][0], lo = RANK_ANCHORS[i + 1][0];
    if (score <= hi && score >= lo) {
      const rHi = RANK_ANCHORS[i][1], rLo = RANK_ANCHORS[i + 1][1];
      const k = (hi - score) / (hi - lo);
      return Math.max(1, Math.round(rHi + (rLo - rHi) * k));
    }
  }
  return last[1];
}

/**
 * 给一所院校挑专业：加权随机（不放回）。
 * 权重 = 门类偏好(院校类型) × 专业热度(就业率)。
 * 权重为 0 的门外直接排除在候选池之外 —— 保证「理工院校不会开临床医学」这种常识。
 */
function pickMajorsFor(college, rng){
  const typeW = TYPE_BOOST[college.type] || TYPE_BOOST['综合'];
  const pool  = MAJORS.map(m => ({
    m: m,
    w: (typeW[m.category] === undefined ? 0.6 : typeW[m.category]) *
       (0.45 + (m.employ_rate - 72) / 28)
  })).filter(p => p.w > 0);
  const want = 10 + Math.floor(rng() * 6);          // 10 ~ 15 个
  const picked = [];
  while (picked.length < want && pool.length) {
    let total = 0;
    pool.forEach(p => { total += p.w; });
    let x = rng() * total, idx = 0;
    for (let i = 0; i < pool.length; i++) { x -= pool[i].w; if (x <= 0) { idx = i; break; } }
    picked.push(pool[idx].m);
    pool.splice(idx, 1);
  }
  return picked;
}

const YEARS = [2022, 2023, 2024, 2025, 2026];
const LATEST_YEAR = Math.max.apply(null, YEARS);

/** 生成全部「院校 × 专业 × 年份」录取记录 */
function buildAdmissionScores(){
  const rows = [];
  let id = 0;
  COLLEGES.forEach(c => {
    const rng  = makeRng(c.id * 7919 + 13);
    const ms   = pickMajorsFor(c, rng);
    ms.forEach(m => {
      const majorAdj = (m.employ_rate - 84) * 0.55;
      const jitter   = (rng() - 0.5) * 4;                 // ±2 分，同一组合每年固定
      YEARS.forEach(y => {
        let min = Math.round(c.score + majorAdj + (y - 2025) * 2 + jitter);
        min = Math.max(430, Math.min(730, min));
        const plan = Math.max(2, Math.min(30,
          Math.round((m.employ_rate - 60) / 1.6 + (c.score - 500) / 40 + (rng() - 0.5) * 4)));
        id++;
        rows.push({
          id: id, college_id: c.id, major_id: m.id, year: y,
          min_score: min, min_rank: rankOfScore(min), plan_count: plan
        });
      });
    });
  });
  return rows;
}

const SCORES = buildAdmissionScores();

/* 回填「专业 → 开设院校」：每所院校只要真开了这个专业就算，
   但列表里只放**录取分最高的 8 所**作为「代表院校」，避免一个专业挂 30 个卡片。 */
(function fillMajorColleges(){
  const best = {};                                        // major_id → [{collegeId, score}]
  SCORES.forEach(r => {
    if (r.year !== LATEST_YEAR) return;
    (best[r.major_id] = best[r.major_id] || []).push({ cid: r.college_id, s: r.min_score });
  });
  MAJORS.forEach(m => {
    const list = (best[m.id] || []).slice()
      .sort((a, b) => (b.s - a.s) || (a.cid - b.cid))
      .slice(0, 8)
      .map(x => x.cid);
    m.colleges = list;
  });
})();

/* ===========================================================================
 * 4. 建表
 * ========================================================================= */
const SCHEMA = `
create table if not exists provinces (
  name         text primary key,
  line         integer not null default 0,
  cnt          integer not null default 0,
  score_offset integer not null default 0,
  seq          integer not null default 0
);

create table if not exists colleges (
  id       integer primary key,
  name     text    not null,
  abbr     text    not null default '',
  province text    not null default '',
  city     text    not null default '',
  level    text    not null default '普通',
  type     text    not null default '',
  score    integer not null default 0,
  is_hot   integer not null default 0,
  intro    text    not null default ''
);
create index if not exists idx_colleges_province on colleges (province);
create index if not exists idx_colleges_level    on colleges (level);

create table if not exists majors (
  id          integer primary key,
  name        text    not null,
  category    text    not null default '',
  subject     text    not null default '',
  degree      text    not null default '',
  years       text    not null default '',
  employ_rate integer not null default 0,
  salary      text    not null default '',
  prospect    text    not null default '',
  colleges    text    not null default '[]'
);
create index if not exists idx_majors_category on majors (category);

create table if not exists careers (
  id          integer primary key,
  name        text    not null,
  category    text    not null default '',
  salary_num  real    not null default 0,
  demand      integer not null default 0,
  growth      text    not null default '',
  description text    not null default '',
  majors      text    not null default '[]'
);

create table if not exists news (
  id         integer primary key,
  title      text    not null,
  date_label text    not null default '',
  tag        text    not null default '',
  tool       text    not null default '',
  tool_label text    not null default '',
  seq        integer not null default 0
);

/* ---- 录取数据（院校 × 专业 × 年份）----
   这张表就是「某大学某专业某年多少分、多少位次、招多少人」。
   分数 / 位次是模型参考值，生成规则见本文件第 3 节，界面已标注口径。 */
create table if not exists admission_scores (
  id          integer primary key,
  college_id  integer not null,
  major_id    integer not null,
  year        integer not null,
  min_score   integer not null default 0,
  min_rank    integer not null default -1,
  plan_count  integer not null default 0
);
/* 幂等防重复：同一「院校 + 专业 + 年份」只能有一条 */
create unique index if not exists uq_admission_scores_slot
  on admission_scores (college_id, major_id, year);
/* 详情页的两个高频查询方向 */
create index if not exists idx_as_college on admission_scores (college_id, year);
create index if not exists idx_as_major   on admission_scores (major_id, year);

/* 志愿表 —— 前端加入志愿时写进来的就是这张表。
   注意：本脚本不重建它，已经加过的志愿会原样保留。 */
create table if not exists volunteers (
  id             integer primary key autoincrement,
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
  unique (kind, ref_id)
);
`;

/* ===========================================================================
 * 5. 执行
 * ========================================================================= */
function main(){
  const fresh = !fs.existsSync(DB_FILE);
  console.log('');
  console.log('  → 数据库文件：' + DB_FILE);
  console.log('    ' + (fresh ? '（首次创建）' : '（已存在：维表会刷新，志愿表保留）'));

  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA foreign_keys = ON');

  const hasTable = (t) => !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const count = (t) => db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;

  /* ---- 先做一次「id 是否重排」校验 ----
     院校 / 专业在本文件里的顺序决定它们的 id。万一顺序变了，志愿表里存的 ref_id
     就会指向另一所学校（界面显示旧校名、点开却是新学校）—— 那是最难发现的脏数据。
     所以这里主动检测：一旦发现重排，就把受影响的表清掉并明确告诉用户。 */
  function idShifted(table, rows){
    if (!hasTable(table)) return false;
    const old = db.prepare('SELECT id, name FROM ' + table).all();
    if (!old.length) return false;
    const map = {};
    old.forEach(r => { map[r.id] = r.name; });
    return rows.some(r => map[r.id] !== undefined && map[r.id] !== r.name);
  }
  const shifted = !fresh && (idShifted('colleges', COLLEGES) || idShifted('majors', MAJORS));

  db.exec(SCHEMA);
  console.log('    ✔ 建表完成（provinces / colleges / majors / careers / news / admission_scores / volunteers）');

  if (shifted) {
    const vol = hasTable('volunteers') ? count('volunteers') : 0;
    if (vol > 0) db.exec('DELETE FROM volunteers');
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'volunteers'");
    ['college_major_groups', 'admission_histories'].forEach(t => {
      if (hasTable(t)) db.exec('DELETE FROM ' + t);
    });
    console.log('');
    console.log('    ⚠ 检测到院校 / 专业的 id 顺序发生了变化（数据量扩充所致）。');
    console.log('      为避免志愿表指向错误的学校，已清空：volunteers' + (vol ? '（原有 ' + vol + ' 条）' : '') +
                '、college_major_groups、admission_histories。');
    console.log('      本文件跑完后，请再运行一次  node init_v2.js  把专业组与历年录取重新生成。');
  }

  db.exec('BEGIN');
  try {
    ['provinces', 'colleges', 'majors', 'careers', 'news', 'admission_scores']
      .forEach(t => db.exec('DELETE FROM ' + t));

    const insP = db.prepare('INSERT INTO provinces (name, full_name, code, line, cnt, score_offset, seq, mode, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    PROVINCE_ROWS.forEach(r => insP.run(r[P.name], r[P.fullName], r[P.code], r[P.line], r[P.cnt], r[P.offset], r[P.seq], r[P.mode], r[P.region]));

    const insC = db.prepare('INSERT INTO colleges (id, name, abbr, province, city, level, type, score, is_hot, intro) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    COLLEGES.forEach(c => insC.run(c.id, c.name, c.abbr, c.province, c.city, c.level, c.type, c.score, c.is_hot, c.intro));

    const insM = db.prepare('INSERT INTO majors (id, name, category, subject, degree, years, employ_rate, salary, prospect, colleges) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    MAJORS.forEach(m => insM.run(m.id, m.name, m.category, m.subject, m.degree, m.years, m.employ_rate, m.salary, m.prospect, JSON.stringify(m.colleges)));

    const insJ = db.prepare('INSERT INTO careers (id, name, category, salary_num, demand, growth, description, majors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    CAREERS.forEach(c => insJ.run(c.id, c.name, c.category, c.salary_num, c.demand, c.growth, c.description, JSON.stringify(c.majors)));

    const insN = db.prepare('INSERT INTO news (id, title, date_label, tag, tool, tool_label, seq) VALUES (?, ?, ?, ?, ?, ?, ?)');
    NEWS.forEach(n => insN.run(n.seq, n.title, n.date_label, n.tag, n.tool, n.tool_label, n.seq));

    const insS = db.prepare('INSERT INTO admission_scores (id, college_id, major_id, year, min_score, min_rank, plan_count) VALUES (?, ?, ?, ?, ?, ?, ?)');
    SCORES.forEach(r => insS.run(r.id, r.college_id, r.major_id, r.year, r.min_score, r.min_rank, r.plan_count));

    db.exec('COMMIT');
    console.log('    ✔ 数据写入完成');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('    ✘ 写入失败，已整体回滚：' + err.message);
    db.close();
    process.exit(1);
  }

  /* ---- 自检：把真实行数读回来给你看 ---- */
  const one = db.prepare('SELECT name, province, level, intro FROM colleges WHERE id = 1').get();
  const perCollege = db.prepare(
    'SELECT MIN(n) AS lo, MAX(n) AS hi FROM (SELECT COUNT(DISTINCT major_id) AS n FROM admission_scores GROUP BY college_id)'
  ).get();
  const covered = db.prepare(
    'SELECT COUNT(DISTINCT major_id) AS n FROM admission_scores'
  ).get().n;
  const sample = db.prepare(`
    SELECT m.name AS major, s.year, s.min_score, s.min_rank, s.plan_count
      FROM admission_scores s JOIN majors m ON m.id = s.major_id
     WHERE s.college_id = 1
     ORDER BY s.min_score DESC, s.year ASC
     LIMIT 6
  `).all();

  console.log('');
  console.log('  =====================================================');
  console.log('   建库完成 ✔');
  console.log('   provinces(生源省份)      : ' + count('provinces') + ' 行');
  console.log('   colleges(院校)           : ' + count('colleges') + ' 行');
  console.log('   majors(专业)             : ' + count('majors') + ' 行');
  console.log('   careers(职业)            : ' + count('careers') + ' 行');
  console.log('   news(资讯)               : ' + count('news') + ' 行');
  console.log('   admission_scores(录取分) : ' + count('admission_scores') + ' 行');
  console.log('   volunteers(志愿)         : ' + count('volunteers') + ' 行   ← 这一张保留你已加入的志愿');
  console.log('  -----------------------------------------------------');
  console.log('   每所院校开设专业数：' + perCollege.lo + ' ~ ' + perCollege.hi + ' 个');
  console.log('   被录取数据覆盖的专业：' + covered + ' / ' + MAJORS.length + ' 个');
  console.log('   抽查第 1 所院校：' + one.name + ' / ' + one.province + ' / ' + one.level);
  console.log('   其简介（由真实字段派生）：' + one.intro);
  if (sample.length) {
    console.log('   抽样 —— ' + one.name + ' 各专业录取参考：');
    sample.forEach(r => {
      console.log('     ' + String(r.year) + ' 年  ' + r.major +
                  '  最低分 ' + r.min_score + '  位次 ' + r.min_rank + '  计划 ' + r.plan_count + ' 人');
    });
  }
  console.log('  =====================================================');
  console.log('');
  console.log('   提醒：admission_scores 里的分数与位次是**模型参考值**，不是官方数据；');
  console.log('         生成规则写在 init_db.js 第 3 节，界面上也标注了口径。');
  console.log('');
  console.log('   下一步：  node init_v2.js   （建「招生专业组 / 历年录取 / 考生」三张表）');
  console.log('');

  db.close();
}

main();
