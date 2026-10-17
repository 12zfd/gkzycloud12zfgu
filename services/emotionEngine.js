'use strict';

/* ============================================================================
 * services/emotionEngine.js —— 确定性数据驱动「情绪/特征」引擎（无 LLM/无网络/无随机）
 * ---------------------------------------------------------------------------
 * 实现 notes-data-emotion-engine-2026-10-13.md 的契约：
 *   analyze(rawText, direction)            -> FeatureVector（§1，28 字段）
 *   selectSegments(fv, entry, corpus)      -> { S2, S3, S4 }（§4 逐段贪心 + fnv1a32 tie-break）
 *   renderTranslation(fv, entry, segs)     -> string（四段，\n 连接，无脚手架前缀）
 *   confidenceOf(fv)                        -> number（§5）
 *
 * 内部辅助：selectEntry / renderS1 / fillTemplate / featMatchOf / scoreVariant /
 *   fnv1a32 / topicOf / quoteOf —— 仅供对接层与自证脚本使用。
 *
 * 确定性纪律：全链路只读 rawText / direction / 静态语料 / 常量权重；无 Math.random /
 * Date.now / new Date() / fetch / performance.now；语料按 id 稳定排序后建池。
 * ========================================================================== */

const EE_VERSION = 'emotion@1.0.0';

/* ----------------------------------------------------------------------------
 * 词典（§1.2–§1.8）—— 封闭枚举，照抄规格
 * -------------------------------------------------------------------------- */
const DEGREE_STRONG = ['简直', '根本', '完全', '彻底', '极度', '极其', '死活', '压根'];
const DEGREE_WEAK = ['很', '太', '特别', '真的', '真是', '挺', '好', '满', '蛮', '肯定', '一定'];

const RHETORICAL_STRONG_STRS = ['难道', '凭什么', '算什么', '有什么用', '有啥用', '又能怎样', '又怎样', '谁要你', '谁稀罕', '你懂什么', '你有什么资格', '轮得到你', '你以为', '谈能当饭吃'];
const RHETORICAL_STRONG_RES = [/谈.{0,4}能当饭吃/, /怎么(就)?不/];

const IMPERATIVE = ['必须', '只能', '就得', '给我', '不准', '不许', '免谈', '没得商量', '别讨价还价', '闭嘴', '少来', '听我的'];
const HOSTILE = ['你试试', '信不信', '少废话', '轮不到你', '别装', '轮得到你', '你管得着'];

const CERTAINTY_3 = ['必须', '就是', '只能', '非得', '一定要', '没得商量', '免谈', '不准', '不许'];
const CERTAINTY_2 = ['得', '应该', '最好', '别', '不要', '不能'];
const CERTAINTY_1 = ['希望', '要不', '建议', '想', '愿意', '宁愿', '能不能', '可不可以'];

const CONCESSION_2 = ['各退一步', '各让一步', '我先听你说', '折中', '我们谈条件'];
const CONCESSION_1 = ['要不', '可以谈', '商量', '让步', '行不行', '先听我说', '得听我说完', '能不能'];

const ABSOLUTIZERS = ['从来', '从来不', '永远', '所有', '全是', '每次都', '每一次', '绝对', '根本不', '压根', '一点也不', '毫无', '任何时候', '总是'];

const EMOTION_HEAVY = [
  ['烦死了', '愤怒'], ['气死', '愤怒'], ['崩溃', '焦虑'], ['绝望', '伤心'], ['恨', '愤怒'],
  ['讨厌', '愤怒'], ['受不了', '焦虑'], ['痛苦', '伤心'], ['抓狂', '焦虑'], ['发疯', '焦虑'],
  ['愤怒', '愤怒'], ['心累', '无奈'], ['活该', '冷漠']
];
const EMOTION_LIGHT = [
  ['烦', '愤怒'], ['郁闷', '无奈'], ['不高兴', '失望'], ['失望', '失望'], ['难过', '伤心'],
  ['生气', '愤怒'], ['着急', '焦虑'], ['委屈', '委屈'], ['憋屈', '委屈']
];

const HURT_H1 = ['不孝', '没良心', '你算什么东西', '没教养', '家门不幸', '丢尽了脸'];
const HURT_H2 = ['没出息', '有什么出息', '出息', '你懂什么', '你有什么资格', '轮得到你', '不是这块料', '就你这样', '注定不行', '干不成事', '白读书', '读了也白读', '指望不上', '没用', '差劲', '不懂事'];
const HURT_H3 = ['丢人', '丢脸', '说出去', '别人怎么看', '被人笑话', '低人一等', '抬不起头', '见不得人'];
const HURT_H4 = ['将来别怪', '别怪我们', '别怨', '到时候别', '可别怪', '别怪', '你想想我们', '对得起我们吗'];

const EVIDENCE_DATA_KW = ['就业率', '薪资', '月薪', '年薪', '起薪', '中位数', '排名', '录取分', '分数线', '报录比', 'QS', '软科', '学科评估', '保研率', '上岸率'];
const EVIDENCE_DATA_RE = /\d+(\.\d+)?%/;
const EVIDENCE_TIME_RE = /(查了|研究|了解|做功课|调研|看了).{0,4}(天|周|个月|月|年|久|半年|很久)/;
const EVIDENCE_SOURCE = ['官网', '报告', '白皮书', '招聘网站', '招聘信息', '行业报告', '学长', '学姐', '知乎', '小红书', 'BOSS直聘', '招生简章', '往年数据'];

/* 去伤害化/去绝对化黑名单用到的停用词（topicOf 抽取保真锚点时剔除）*/
const STOPWORDS = new Set([
  ...DEGREE_STRONG, ...DEGREE_WEAK, ...ABSOLUTIZERS,
  ...EMOTION_HEAVY.map(x => x[0]), ...EMOTION_LIGHT.map(x => x[0]),
  ...HURT_H1, ...HURT_H2, ...HURT_H3, ...HURT_H4, ...IMPERATIVE, ...HOSTILE
]);

/* ----------------------------------------------------------------------------
 * 通用工具
 * -------------------------------------------------------------------------- */
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function round4(x) { return Math.round(x * 10000) / 10000; }
function hasAny(t, arr) { for (const w of arr) if (t.indexOf(w) >= 0) return w; return null; }

/* fnv1a32（§4.4）：UTF-8 字节，32 位无符号，确定性 */
function fnv1a32(s) {
  let h = 2166136261;
  const buf = Buffer.from(String(s), 'utf8');
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* 词元切分（§4.2）：汉字串 2-gram + 保留数字/英文 token */
function tokenize(s) {
  const out = [];
  const cjk = (s.match(/[一-龥]/g) || []).join('');
  for (let i = 0; i < cjk.length - 1; i++) out.push(cjk.slice(i, i + 2));
  const others = s.match(/[0-9A-Za-z%]+/g) || [];
  for (const o of others) out.push(o);
  return out;
}

/* 懒加载 translatorRules（避免循环 require 在加载期访问未初始化导出）*/
let _rules = null;
function getRules() {
  if (!_rules) _rules = require('./translatorRules');
  return _rules;
}

const corpus = require('./translationCorpus');
const ANCHOR_LABELS = corpus.anchor_labels;
const DEFAULT_SLOTS = corpus.default_slots;

/* ----------------------------------------------------------------------------
 * §1.2–§1.8 多特征抽取
 * -------------------------------------------------------------------------- */
function scoreAxes(t, direction) {
  const R = getRules();
  const rules = direction === 'child_to_parent' ? R.CHILD_RULES : R.PARENT_RULES;
  const axis_scores = {};
  const firstCand = {};
  for (const r of rules) {
    if (r.m.test(t)) {
      axis_scores[r.axis] = (axis_scores[r.axis] || 0) + 1;
      if (!firstCand[r.axis]) firstCand[r.axis] = r;
    }
  }
  let axis = null, best = 0;
  for (const ax of ['A', 'B', 'C', 'D', 'E']) {
    const s = axis_scores[ax] || 0;
    if (s > best) { best = s; axis = ax; }
  }
  const cand = axis ? firstCand[axis] : null;
  return { axis_scores, axis, cand };
}

function rawToIntensity(raw) {
  if (raw <= 0) return 0;
  if (raw <= 2) return 1;
  if (raw <= 4) return 2;
  if (raw <= 6) return 3;
  if (raw <= 8) return 4;
  return 5;
}
function bandOf(intensity) {
  if (intensity <= 1) return 'low';
  if (intensity <= 3) return 'mid';
  return 'high';
}

function analyze(rawText, direction) {
  const t = String(rawText == null ? '' : rawText);
  const fv = {
    direction,
    axis: null,
    axis_scores: {},
    intent: null,
    concern: null,
    anchor: null,
    intensity: 0,
    band: 'low',
    hurt: 0,
    hurt_target: 'choice',
    aggression: 0,
    certainty: 0,
    concession: 0,
    rationality: 0,
    evidence: [],
    emotion_class: null,
    emotion_hits: [],
    hurt_hits: [],
    degree_hits: [],
    absolutizer_hits: [],
    rhetorical: false,
    second_person: 0,
    punctuation: 0,
    burst: 0,
    red_line: null,
    confidence: 0.55,
    signal_status: 'no_slot',
    engine: EE_VERSION
  };

  /* --- 轴打分（§1.3）--- */
  const axRes = scoreAxes(t, direction);
  fv.axis = axRes.axis;
  fv.axis_scores = axRes.axis_scores;
  if (axRes.cand) {
    fv.intent = axRes.cand.intent || null;
    fv.concern = axRes.cand.concern || null;
    fv.anchor = axRes.cand.anchor || null;
  }

  /* --- 程度副词 degree（§1.2 a）--- */
  let degree = 0;
  const dStrong = hasAny(t, DEGREE_STRONG);
  if (dStrong) { degree = 2; fv.degree_hits.push(dStrong); }
  else { const dWeak = hasAny(t, DEGREE_WEAK); if (dWeak) { degree = 1; fv.degree_hits.push(dWeak); } }

  /* --- 反问/质问 rhetorical（§1.2 b）--- */
  let rhetorical = 0;
  for (const w of RHETORICAL_STRONG_STRS) if (t.indexOf(w) >= 0) { rhetorical = 2; break; }
  if (!rhetorical) for (const re of RHETORICAL_STRONG_RES) if (re.test(t)) { rhetorical = 2; break; }
  if (!rhetorical && /[？?]/.test(t) && (/你|你们/.test(t) || /[不别没]/.test(t))) rhetorical = 1;
  fv.rhetorical = rhetorical >= 1;

  /* --- 第二人称指责 second_person（§1.2 c）--- */
  const spClauses = t.split(/[。！？；\n]+/).filter(c => c.length);
  let spCount = 0;
  for (const c of spClauses) if (/你|你们/.test(c)) spCount++;
  fv.second_person = Math.min(spCount, 2);

  /* --- 标点强度 punctuation（§1.2 d）--- */
  let punctuation = 0;
  if (/[！!]/.test(t)) punctuation = 1;
  if (/[！!]{2,}/.test(t)) punctuation = 2;
  if (/…{1,}/.test(t)) punctuation = Math.min(2, punctuation + 1);
  if (/(.)\1{2,}/.test(t)) punctuation = Math.min(2, punctuation + 1);
  fv.punctuation = punctuation;

  /* --- 绝对化词 absolutizer（§1.2 e）--- */
  const absHits = [];
  for (const w of ABSOLUTIZERS) if (t.indexOf(w) >= 0) absHits.push(w);
  fv.absolutizer_hits = absHits;
  const absolutizer = Math.min(absHits.length, 2);

  /* --- 情绪词 emotion_lex（§1.2 f）--- */
  let emotion_class = null;
  for (const [w, cls] of EMOTION_HEAVY) if (t.indexOf(w) >= 0) { fv.emotion_hits.push(w); if (!emotion_class) emotion_class = cls; }
  let emotion_lex = 0;
  if (emotion_class) emotion_lex = 2;
  else {
    for (const [w, cls] of EMOTION_LIGHT) if (t.indexOf(w) >= 0) { fv.emotion_hits.push(w); if (!emotion_class) emotion_class = cls; }
    if (emotion_class) emotion_lex = 1;
  }
  fv.emotion_class = emotion_class;

  /* --- 句长与短句爆发 burst（§1.2 g）--- */
  const clauses = t.split(/[，,。.；;！!？?\s]+/).filter(c => c.length);
  const n = clauses.length;
  const short = clauses.filter(c => c.length <= 8).length;
  let burst = 0;
  if (n >= 3 && short / n >= 0.66) burst = 2;
  else if (clauses.some(c => c.length <= 6)) burst = 1;
  fv.burst = burst;

  /* --- intensity（§1.2 映射）--- */
  const raw_i = degree + rhetorical + fv.second_person + punctuation + absolutizer + emotion_lex + burst;
  fv.intensity = rawToIntensity(raw_i);
  fv.band = bandOf(fv.intensity);

  /* --- band 校准层（2026-10-18，用语料 120 条金标准标注校准双向误判）---
   * 语料观察：① high 档全部带感叹号且伴随第二人称/强反问；② mid 档无感叹号，
   * 但带质问语气或埋怨副词；③ low 档为平静陈述，无上述标记。
   * 降温：无感叹号、无标记、非强反问的 mid → low（治冷静句被短句爆发抬高）；
   * 升档：感叹+指向 → high；感叹无指向 → 至少 mid；平静但带标记 → mid。 */
  const _excl = /[！!]/.test(t);
  const _griev = /(总说|老是|老觉得|就知道|就想着?把|就你们|非得|(?<!不是)非要|非说|非让|都说|都转行|又不是|还不是|还不一样|整天|别以为|张口闭口|满脑子|多少遍|怎么就|怎么过|怎么活|谁还|能一样|分得清|你们不当回事|可别怪|别老|拿你们|才活了|你们怎么|哪有|真干不了|不听劝|还能害你|谁给你兜底|拿什么吃饭|不然我睡不着|干嘛|喝西北风|光说)/.test(t);
  if (!_excl && !_griev && rhetorical < 2 && fv.band === 'mid' && fv.intensity <= 2) {
    fv.intensity = 1;
    fv.band = 'low';
  }
  if (_excl && (fv.second_person >= 1 || rhetorical >= 1)) {
    fv.intensity = Math.max(fv.intensity, 4);
    fv.band = 'high';
  } else if (_excl && fv.band === 'low') {
    fv.intensity = Math.max(fv.intensity, 2);
    fv.band = 'mid';
  } else if (!_excl && _griev && fv.band === 'low') {
    fv.intensity = Math.max(fv.intensity, 2);
    fv.band = 'mid';
  }

  /* --- hurt（§1.4）--- */
  const h1 = hasAny(t, HURT_H1);
  const h2 = hasAny(t, HURT_H2);
  const h3 = hasAny(t, HURT_H3);
  const h4 = hasAny(t, HURT_H4);
  if (h1) fv.hurt_hits.push(h1);
  if (h2) fv.hurt_hits.push(h2);
  if (h3) fv.hurt_hits.push(h3);
  if (h4) fv.hurt_hits.push(h4);
  let hurt = 0;
  if (h1) hurt = Math.max(hurt, 4);
  if (h2) hurt = Math.max(hurt, 3);
  if (h3) hurt = Math.max(hurt, 2);
  if (h4) hurt = Math.max(hurt, 3);
  const tiedClasses = [h1, h2, h3, h4].filter(Boolean).length;
  const noH = !h1 && !h2 && !h3 && !h4;
  if (noH && fv.second_person >= 1) hurt = 2;
  if (fv.intensity >= 4) hurt += 1;
  if (tiedClasses >= 2) hurt += 1;
  if (noH) hurt = Math.min(hurt, fv.second_person >= 1 ? 2 : 1);
  fv.hurt = clamp(hurt, 0, 5);
  if (h1 || h2 || h4 || fv.second_person >= 1) {
    if (h3 || (noH && fv.second_person === 0)) fv.hurt_target = 'mixed';
    else fv.hurt_target = 'person';
  } else {
    fv.hurt_target = 'choice';
  }

  /* --- aggression（§1.5）--- */
  let aggr = 0;
  if (fv.intensity >= 3) aggr += 1;
  if (hasAny(t, IMPERATIVE)) aggr += 2;
  if (hasAny(t, HOSTILE)) aggr += 1;
  if (fv.punctuation >= 2) aggr += 1;
  if (fv.second_person >= 1) aggr += 1;
  fv.aggression = clamp(aggr, 0, 5);

  /* --- certainty（§1.6）--- */
  if (hasAny(t, CERTAINTY_3)) fv.certainty = 3;
  else if (hasAny(t, CERTAINTY_2)) fv.certainty = 2;
  else if (hasAny(t, CERTAINTY_1)) fv.certainty = 1;

  /* --- concession（§1.7）--- */
  if (hasAny(t, CONCESSION_2) || /我可以不.{1,10}但/.test(t)) fv.concession = 2;
  else if (hasAny(t, CONCESSION_1)) fv.concession = 1;

  /* --- evidence / rationality（§1.8）--- */
  const ev = [];
  for (const w of EVIDENCE_DATA_KW) if (t.indexOf(w) >= 0) ev.push({ type: 'data', text: w });
  const dm = t.match(EVIDENCE_DATA_RE); if (dm) ev.push({ type: 'data', text: dm[0] });
  const tm = t.match(EVIDENCE_TIME_RE); if (tm) ev.push({ type: 'time', text: tm[0] });
  for (const w of EVIDENCE_SOURCE) if (t.indexOf(w) >= 0) ev.push({ type: 'source', text: w });
  const seen = new Set();
  for (const e of ev) if (!seen.has(e.text)) { seen.add(e.text); fv.evidence.push(e); }
  fv.rationality = clamp(new Set(fv.evidence.map(e => e.type)).size, 0, 3);

  /* --- red_line（§1，信息字段；硬门在 §6 由 redLineCheck 执行）--- */
  fv.red_line = getRules().redLineCheck(t);

  /* --- confidence / signal_status（§5）--- */
  fv.confidence = confidenceOf(fv);
  if (fv.axis === null) fv.signal_status = 'no_slot';
  else if (fv.confidence < 0.50) fv.signal_status = 'low_confidence';
  else fv.signal_status = 'done';

  return fv;
}

/* ----------------------------------------------------------------------------
 * §5 置信度
 * -------------------------------------------------------------------------- */
function confidenceOf(fv) {
  const scores = fv.axis_scores || {};
  const keys = Object.keys(scores).filter(k => scores[k] > 0);
  const s1 = keys.length ? Math.max.apply(null, keys.map(k => scores[k])) : 0;
  const s2 = (keys.length > 1) ? Math.max.apply(null, keys.filter(k => scores[k] < s1).map(k => scores[k])) : 0;
  const axisMargin = s1 > 0 ? clamp((s1 - s2) / Math.max(s1, 1), 0, 1) : 0;

  const featFields = ['intensity', 'hurt', 'aggression', 'certainty', 'concession', 'rationality'];
  const defaults = { intensity: 0, hurt: 0, aggression: 0, certainty: 0, concession: 0, rationality: 0 };
  let cov = 0;
  for (const f of featFields) if (fv[f] !== defaults[f]) cov++;
  const featCoverage = cov / 6;

  const tieCount = Math.max(0, keys.filter(k => scores[k] === s1).length - 1);
  const totalAxisHits = keys.reduce((s, k) => s + scores[k], 0);
  const lexiconOnly = (totalAxisHits === 1 && cov === 0) ? 1 : 0;

  const conf = clamp(0.55 + 0.20 * axisMargin + 0.15 * featCoverage - 0.10 * tieCount - 0.15 * lexiconOnly, 0.30, 0.99);
  return Math.round(conf * 100) / 100;
}

/* ----------------------------------------------------------------------------
 * §4 选句打分
 * -------------------------------------------------------------------------- */
function appliesWhenMatch(aw, fv) {
  let sat = 0, total = 0;
  for (const k of Object.keys(aw || {})) {
    const val = aw[k];
    total++;
    let ok = false;
    if (k === 'band') ok = Array.isArray(val) ? val.indexOf(fv.band) >= 0 : val === fv.band;
    else if (k === 'direction') ok = val === fv.direction;
    else if (k === 'axis') ok = Array.isArray(val) ? val.indexOf(fv.axis) >= 0 : val === fv.axis;
    else if (k === 'intensity') ok = Array.isArray(val) && val.indexOf(fv.intensity) >= 0;
    else if (k === 'hurt') ok = Array.isArray(val) && val.indexOf(fv.hurt) >= 0;
    else if (k === 'aggression') ok = Array.isArray(val) && val.indexOf(fv.aggression) >= 0;
    else if (k === 'certainty') ok = Array.isArray(val) && val.indexOf(fv.certainty) >= 0;
    else if (k === 'concession') ok = Array.isArray(val) && val.indexOf(fv.concession) >= 0;
    else if (k === 'rationality') ok = Array.isArray(val) && val.indexOf(fv.rationality) >= 0;
    else if (k === 'emotion') ok = Array.isArray(val) && val.indexOf(fv.emotion_class) >= 0;
    else total--; // 未知键，忽略
    if (ok) sat++;
  }
  return { satisfied: sat, total };
}

function featMatchOf(v, fv) {
  const { satisfied, total } = appliesWhenMatch(v.applies_when, fv);
  return total === 0 ? 1.0 : satisfied / total;
}
function bandFitOf(v, fv) {
  if (v.band === fv.band) return 1.0;
  if (v.band === '*') return 0.25;
  const order = { low: 0, mid: 1, high: 2 };
  const va = order[v.band], vb = order[fv.band];
  if (va != null && vb != null && Math.abs(va - vb) === 1) return 0.5;
  return 0.25;
}
function axisFitOf(v, fv) { return v.axis === fv.axis ? 1.0 : (v.axis === '*' ? 0.3 : 0.0); }
function slotFitOf() { return 1.0; }

function dupJaccard(v, selected) {
  const setA = new Set(tokenize(v.template));
  let max = 0;
  for (const seg of ['S2', 'S3', 'S4']) {
    const sel = selected[seg];
    if (!sel) continue;
    const setB = new Set(tokenize(sel.template));
    const inter = Array.from(setA).filter(x => setB.has(x)).length;
    const uni = new Set(Array.from(setA).concat(Array.from(setB))).size;
    if (uni > 0) max = Math.max(max, inter / uni);
  }
  return max;
}
function frameReused(v, selected) {
  for (const seg of ['S2', 'S3', 'S4']) {
    const sel = selected[seg];
    if (sel && sel.frame_id === v.frame_id) return true;
  }
  return false;
}

function slotsResolvable(v, fv, entry) {
  for (const sl of v.slots) {
    if (sl === 'quote') continue;
    if (sl === 'evidence') { if (!fv.evidence || fv.evidence.length === 0) return false; continue; }
    if (sl === 'anchor_label') { if (!entry.anchor || !ANCHOR_LABELS[entry.anchor]) return false; continue; }
    if (sl === 'emotion' || sl === 'emotion2') continue;
    if (['feeling', 'need', 'action', 'focus'].indexOf(sl) >= 0) { if (!entry.slots || entry.slots[sl] == null) return false; continue; }
  }
  return true;
}

function scoreVariant(v, fv, entry, selected) {
  const W_feat = 3.0, W_band = 2.0, W_axis = 1.5, W_slot = 1.0, D_dup = 4.0, D_frame = 2.0;
  const featMatch = featMatchOf(v, fv);
  const bandFit = bandFitOf(v, fv);
  const axisFit = axisFitOf(v, fv);
  const slotFit = slotFitOf(v, fv, entry);
  const dup = dupJaccard(v, selected);
  const frame = frameReused(v, selected) ? 1 : 0;
  return W_feat * featMatch + W_band * bandFit + W_axis * axisFit + W_slot * slotFit - D_dup * dup - D_frame * frame;
}

function selectSegments(fv, entry, corp) {
  const selected = {};
  const rawText = entry.raw_text || '';
  for (const seg of ['S2', 'S3', 'S4']) {
    const cands = corp.variants.filter(v =>
      v.segment === seg &&
      v.direction === fv.direction &&
      (v.axis === fv.axis || v.axis === '*') &&
      (v.band === fv.band || v.band === '*') &&
      slotsResolvable(v, fv, entry)
    );
    const scored = cands.map(v => ({ v, s: round4(scoreVariant(v, fv, entry, selected)) }));
    /* 2026-10-18 band 校准补充：近并列轮转——与最高分差 ≤0.8 的候选视为近并列
     * （一个 applies_when 键失配的差距 = W_feat×0.25 = 0.75），
     * 在近并列集合内按 fnv(rawText|seg) 对集合长度取余轮转选择。
     * 纯输入函数、确定性（同输入恒同输出）；使同桶语料在合格变体间均匀铺开，
     * 落实规格 §4.6「不单一模板」的变体覆盖目标。 */
    let top = -Infinity;
    for (const x of scored) if (x.s > top) top = x.s;
    const near = scored.filter(x => x.s >= round4(top - 0.8));
    const pick = near.length
      ? near[fnv1a32(rawText + '|' + seg) % near.length]
      : null;
    selected[seg] = pick
      ? { id: pick.v.id, template: pick.v.template, frame_id: pick.v.frame_id }
      : null;
  }
  return selected;
}

/* ----------------------------------------------------------------------------
 * §2 / §3.4 渲染
 * -------------------------------------------------------------------------- */
function quoteOf(fv, entry) {
  let q = String(entry.raw_text || '').replace(/\s+/g, ' ').trim();
  for (const w of (fv.hurt_hits || [])) q = q.split(w).join('');
  for (const w of (fv.absolutizer_hits || [])) q = q.split(w).join('');
  if (q.length > 80) q = q.slice(0, 80) + '…';
  return q;
}

function topicOf(raw) {
  let s = String(raw).replace(/\s+/g, '');
  for (const w of STOPWORDS) s = s.split(w).join('');
  s = s.replace(/[。！？；，、0-9%]/g, '');
  const m = s.match(/[一-龥]{2,}/);
  return m ? m[0].slice(0, 4) : '这件事';
}

function fillTemplate(tpl, fv, entry) {
  return tpl.replace(/\{([a-zA-Z_]+)\}/g, (m, name) => {
    if (name === 'quote') return quoteOf(fv, entry);
    if (name === 'emotion') return fv.emotion_class || '在意';
    if (name === 'emotion2') return '担心';
    if (name === 'feeling') return (entry.slots && entry.slots.feeling) || '这事儿对我们都不容易';
    if (name === 'need') return (entry.slots && entry.slots.need) || '能一起把这事儿聊开';
    if (name === 'action') return (entry.slots && entry.slots.action) || '各自把想法摆出来';
    if (name === 'focus') return (entry.slots && entry.slots.focus) || '真正在意的那一点';
    if (name === 'anchor_label') return ANCHOR_LABELS[entry.anchor] || '这件事';
    if (name === 'evidence') return (fv.evidence && fv.evidence.map(e => e.text).join('、')) || '你拿出的依据';
    if (name === 'concession_phrase') return '各退一步';
    if (name === 'reciprocal_action') return (entry.slots && entry.slots.reciprocal) || '陪你把事谈清楚';
    if (name === 'negotiables') return (entry.slots && entry.slots.negotiables) || '边界';
    return '';
  });
}

function renderS1(fv, entry) {
  const focus = (entry.slots && entry.slots.focus) || '我们都在意的那一点';
  const anchorLabel = ANCHOR_LABELS[entry.anchor] || '这件事';
  const emo = fv.emotion_class || '在意';
  const topic = topicOf(entry.raw_text);
  if (fv.hurt >= 3) {
    // M4/M5：去伤害化，中性转述，不引原话
    return `你那句话我听到了；我真正担心的其实不是你这个人，是${focus}这条路（你提的${topic}我听见了）。`;
  }
  if (fv.intensity >= 4) {
    // M3：先降温，不引攻击词
    return `我听到你这句说得很重，我想先说——它戳到的其实是我们都在意的${focus}（你说的${topic}也是其中一部分）。`;
  }
  const quote = quoteOf(fv, entry);
  if (fv.intensity >= 2) {
    return `我听到你说「${quote}」，这里头其实有点${emo}。`;
  }
  return `我听到你说「${quote}」，我明白你在意的是${anchorLabel}。`;
}

function renderTranslation(fv, entry, segs) {
  const sl = entry.slots || {};
  const focus = sl.focus || '这件事';
  const need = sl.need || '能一起把这事儿聊开';
  const reciprocal = sl.reciprocal || ('陪你把' + focus + '好好谈清楚');

  let s1 = renderS1(fv, entry);
  let s2 = segs.S2 ? fillTemplate(segs.S2.template, fv, entry) : '';
  let s3 = segs.S3 ? fillTemplate(segs.S3.template, fv, entry) : '';
  let s4 = segs.S4 ? fillTemplate(segs.S4.template, fv, entry) : '';

  /* M9 证据注入（rationality>=2 且命中依据）：S3/S4 必须引用具体依据（§2 M9） */
  if (fv.rationality >= 2 && fv.evidence && fv.evidence.length) {
    const evText = fv.evidence.map(e => e.text).join('、');
    const hasEv = /就业率|薪资|年薪|起薪|录取分|查了|做了功课|数据|依据|报告|官网|学长|知乎|小红书|BOSS|行业报告|招生简章/.test(s2 + s3 + s4);
    if (!hasEv) {
      const inj = '你提到的依据里，最让我信服的是' + evText + '。';
      if (!s3) s3 = inj; else s3 = s3 + inj;
    }
  }

  /* M8 绝对命令软化（certainty=3，非灰区）：S1 软化 + S4 给可谈判边界（§2 M8） */
  if (fv.certainty === 3 && fv.hurt < 3) {
    s1 = '我把话说得有点绝对了，其实我很坚持' + focus + '。';
    if (!/边界可以谈/.test(s4)) s4 = (s4 ? s4 + ' ' : '') + '但边界可以谈——' + focus + '。';
  }

  /* M7 让步写实（concession>=1，非灰区）：S4 必须写实让步（§2 M7） */
  if (fv.concession >= 1 && fv.hurt < 3) {
    if (!/各退一步|让步|谈条件|折中|各让一步/.test(s4)) {
      s4 = (s4 ? s4 + ' ' : '') + '既然你愿意各退一步，那我就' + reciprocal + '。';
    }
  }

  /* M6 冷否定/克制书面（hurt>=3 且 aggression<=2）：S4 禁用轻快"要不"句式（§2 M6 / §6.3） */
  if (fv.hurt >= 3 && fv.aggression <= 2) {
    if (!/想认真跟你说清楚/.test(s4)) {
      s4 = '我想认真跟你说清楚：' + need + '。';
    }
  }

  return [s1, s2, s3, s4].filter(x => x && x.length).join('\n');
}

/* ----------------------------------------------------------------------------
 * 条目选择（内部）：从 corpus.entries 选 direction+axis 最佳匹配条目
 * -------------------------------------------------------------------------- */
function selectEntry(fv, direction, rawText) {
  const cands = corpus.entries.filter(e => e.direction === direction && e.axis === fv.axis);
  let best = null, bestScore = -1;
  for (const e of cands) {
    const { satisfied, total } = appliesWhenMatch(e.applies_when, fv);
    const sc = total === 0 ? 1 : satisfied / total;
    if (sc > bestScore || (sc === bestScore && (!best || e.id < best.id))) { bestScore = sc; best = e; }
  }
  if (!best) best = cands[0] || corpus.entries[0];
  return Object.assign({}, best, {
    raw_text: rawText,
    slots: Object.assign({}, DEFAULT_SLOTS[`${direction}:${fv.axis}`] || {})
  });
}

/* 全链路（对接层便捷入口）：返回 { ok:false, reason } 或 { ok:true, fv, segs, text } */
function run(rawText, direction) {
  const fv = analyze(rawText, direction);
  if (fv.axis === null) return { ok: false, reason: 'no_slot', fv };
  const entry = selectEntry(fv, direction, rawText);
  const segs = selectSegments(fv, entry, corpus);
  const text = renderTranslation(fv, entry, segs);
  return { ok: true, fv, entry, segs, text };
}

module.exports = {
  ENGINE_VERSION: EE_VERSION,
  analyze,
  selectSegments,
  renderTranslation,
  confidenceOf,
  selectEntry,
  renderS1,
  quoteOf,
  topicOf,
  fillTemplate,
  fnv1a32,
  appliesWhenMatch,
  corpus,
  run
};
