# d-impl-4 断点交接（2026-10-18 00:45，主理人诊断）

## 你的断点状态
- 已落盘：`services/emotionEngine.js`(00:22) / `services/translationCorpus.js` / `services/translatorRules.js`(00:16，已接入)
- 你写的自测 `.workbuddy/qa/_emotion-engine.js` 已可运行，结果：
  - **T01–T20：75 通过 / 0 失败**（核心引擎逻辑没问题）
  - A1–A11：10 通过 / **2 失败**：A2 跨档多样性 1/40（阈 8）、A11 变体覆盖 65/214=30.4%（阈 60%）
- 你在修复 A2/A11 时因 429 配额中断（03:24 已重置）。**下面是主理人的精确诊断，直接从这里继续。**

## 根因（已实锤，不用再排查）
**不是 selectSegments 的锅**（逐段贪心+fnv1a32 tie-break 实现正确），是 **`analyze()` 对语料自己的原话失明**：

- 语料 120 条 entries：`axis=null` **81 条（67.5%）**，正常 38 条，red_line 1 条（child/parent 两侧都是 ~40 条失明）
- 失明样本全是**冷静陈述句**（低强度、逗号分隔、无感叹号）：
  - `妈，我是真的喜欢生物，不是一时兴起，我把这专业能做什么都查过了`（low|child）
  - `我知道学医稳定，可我读下来会很痛苦，我更想选一个能坚持四年的`（low|child）
  - `爸，我不排斥稳定，只是不想为了稳定去学一个我一点感觉都没有的专业`（low|child）
- 后果链：axis=null → `selectEntry` 兜底 `cands[0]||entries[0]` → 三档全部命中 `G-cA-low-1` → A2 三元组全同、A11 大量变体永远选不到
- 次生问题：解析成功的 38 条里 **band 频繁误判**（样本见 `_corpus-census.js` 输出：entry.band=high→fv.band=low 等双向错档），强度阈值对冷静句偏严

## 修复方向（建议，按规格走）
1. 通读 `deliverables/product-strategy/notes-data-emotion-engine-2026-10-13.md` 里 axis 判定与强度分档两节的**词典边界**，确认"封闭枚举"允许的扩展方式；若词典确实缺冷静句式的线索词（喜欢/兴趣/想学/不排斥/更想/查过/坚持…），按规格的扩展点补
2. band 校准：冷静陈述句（陈述理由型）多落在 low/mid，激烈排比/反问/人身攻击落在 high；用 120 条语料的 entry.band 标注做校准基准（它们是研究员标注的金标准）
3. 红线：T01–T20 不得回归；无 Math.random/Date/fetch（B5 会扫）；词典扩展保持确定性

## 验证闭环（全绿才算完）
```
node .workbuddy/qa/_emotion-engine.js      # T 75/0 + A 11/0
node .workbuddy/qa/_accept19.js index.html # ≥71（B1/B2/C1/C2 是 d-impl-5 re-inline 前的预期漂移，不算你的）
node --check services/emotionEngine.js services/translatorRules.js
```
然后本地 commit（git 全路径 `"C:\Program Files\Git\cmd\git.exe"`，中文 message，不 push），向 team-lead 报 hash。

## 附：诊断工具（可复跑）
`.workbuddy/qa/_corpus-census.js` —— 语料普查+失明率+band 误判样本，修完后应看到 axis=null 归零、band 误判显著下降。
