/* ============================================================================
 * domain-d/inject.js —— 确定性注入脚本（仅 dev 工具，不进 index.html）
 * ---------------------------------------------------------------------------
 * 把 domain-d/app.css / domain-d/app.js 内联成两个独立块：
 *   <style id="d-domain">…</style>   （插在主 </style> 之后）
 *   <script id="d-domain">…</script> （插在主 </script> 之后、</body> 之前）
 * 并在 index.html 做 5 处「只增」接入（tab / valid / switch）。
 *
 * 铁律（与 _accept19.js 静态层门禁对齐）：
 *   1) 注入块的内容必须与源文件逐字节相同 —— 不自校验通过绝不落盘。
 *   2) 每个接入锚点必须 must(hit===1)，否则整体不落盘。
 *   3) 幂等：每次运行先回滚上一次注入，再重新注入，结果可重现。
 *   4) 不触碰既有 A/B/C/E 域节点；不新增页面节点 id 属性。
 *
 * 用法：node domain-d/inject.js [path/to/index.html]
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..');
const HTML_PATH = process.env.GKZY_HTML || path.join(DIR, '..', 'index.html');
const CSS_PATH = path.join(DIR, 'app.css');
const JS_PATH = path.join(DIR, 'app.js');

function must(cond, msg){ if (!cond) { throw new Error('[inject] 自检失败：' + msg); } }
function countOf(s, sub){ return s.split(sub).length - 1; }
function countRe(s, re){ return (s.match(re) || []).length; }

/* ---------- 读取源文件（逐字节保留） ---------- */
const cssRaw = fs.readFileSync(CSS_PATH, 'utf8');
const jsRaw = fs.readFileSync(JS_PATH, 'utf8');
let html = fs.readFileSync(HTML_PATH, 'utf8');

/* ---------- valid 数组字面量（原始 / 注入后） ---------- */
const VALID_LITERAL = "['home', 'college', 'major', 'career', 'plan', 'volunteer', 'mine']";
const VALID_LITERAL_FAMILY = VALID_LITERAL.replace(/\]$/, ", 'family']");
must(VALID_LITERAL_FAMILY !== VALID_LITERAL, 'valid 注入字面量构造失败');

/* ---------- 幂等回滚：把上一次注入的片段**连同其换行**还原为原始锚点文本 ----------
 * ★ 历史缺陷（2026-10-12，已修）：原回滚只删块本身、不吃掉注入时引入的换行，
 *   于是注入一次后文本变成 `</style>\n\n</head>`、`  </button>\n\n</nav>`，
 *   锚点 `'</style>\n</head>'` / `'  </button>\n</nav>'` 再也命中不了 →
 *   第二次运行必然 must 失败（也就是"看起来幂等、实际只能跑一次"）。
 *   这里统一用 /\n?…\n?/ + 替换为单个 '\n'，精确还原锚点。 */
function rollbackD(h){
  let s = h;
  s = s.replace(/\n?<style id="d-domain">[\s\S]*?<\/style>\n?/g, '\n');
  s = s.replace(/\n?<script id="d-domain">[\s\S]*?<\/script>\n?/g, '\n');
  s = s.replace(/\n?  <!-- D-DOMAIN-TAB-START -->[\s\S]*?<!-- D-DOMAIN-TAB-END -->\n?/g, '\n');
  s = s.replace(/\n?      \/\* D-DOMAIN-CASES-START \*\/[\s\S]*?\/\* D-DOMAIN-CASES-END \*\/\n?/g, '\n');
  /* ★ 回滚 valid：必须把 'family' 从**数组内部**摘掉。
   *   历史缺陷（2026-10-12，已修）：此处原为 s.split(", 'family'").join('')，
   *   而下游注入写的是 VALID_LITERAL + ", 'family'"。两者合起来产出
   *       const valid = ['home', ..., 'mine'], 'family';
   *   —— 这是 comma expression（第二个声明符是字符串字面量而非标识符），
   *   导致主脚本整块 SyntaxError → Controller/UI/API/State 全部未定义 → 整站白屏。
   *   现在两侧都改为「在数组内追加 / 在数组内摘除」，并由下方落盘前语法门禁兜底。 */
  s = s.split(VALID_LITERAL_FAMILY).join(VALID_LITERAL);
  return s;
}
html = rollbackD(html);
/* ★ 注入前的基准 = **回滚之后的干净态**，不是磁盘原文 ——
 *   磁盘原文可能已经是上一次注入的结果，拿它当基准会误报幂等失败。 */
const origHtml = html;

/* ---------- 锚点唯一性校验（must hit===1） ---------- */
must(countOf(html, '</style>\n</head>') === 1, "主样式 </style> 之后插入点不唯一");
must(countOf(html, '</script>\n</body>') === 1, "主脚本 </script> 之后插入点不唯一");
must(countOf(html, '  </button>\n</nav>') === 1, "第 5 个 tab 之后插入点不唯一");
must(countOf(html, VALID_LITERAL) === 1, "valid 数组字面量不唯一");
must(countOf(html, '    switch (action) {') === 1, "switch (action) 锚点不唯一");

/* ---------- 1) 样式块：插在主 </style> 之后、</head> 之前 ---------- */
html = html.replace('</style>\n</head>',
  '</style>\n<style id="d-domain">' + cssRaw + '</style>\n</head>');

/* ---------- 2) 脚本块：插在主 </script> 之后、</body> 之前 ---------- */
html = html.replace('</script>\n</body>',
  '</script>\n<script id="d-domain">' + jsRaw + '</script>\n</body>');

/* ---------- 3) 第 6 个 tab：插在 volunteer 关闭 </button> 之后、</nav> 之前 ---------- */
const TAB_ANCHOR = '  </button>\n</nav>';
const TAB_BLOCK =
  '  </button>\n' +
  '  <!-- D-DOMAIN-TAB-START -->\n' +
  '  <button class="tab-item" data-action="fam-open" data-target="family">\n' +
  '    <i class="fa-solid fa-users"></i><span>家庭</span>\n' +
  '  </button>\n' +
  '  <!-- D-DOMAIN-TAB-END -->\n' +
  '</nav>';
html = html.replace(TAB_ANCHOR, TAB_BLOCK);

/* ---------- 4) valid 数组**内部**尾部追加 'family'（必须写在 ] 之前） ---------- */
html = html.replace(VALID_LITERAL, VALID_LITERAL_FAMILY);

/* ---------- 5) switch (action) 内只新增 fam-* 派发分支 ---------- */
const CASES_BLOCK =
  '    switch (action) {\n' +
  '      /* D-DOMAIN-CASES-START */\n' +
  "      case 'fam-open':         Controller.famOpen(); break;\n" +
  "      case 'fam-select-room':   Controller.famSelectRoom(el.getAttribute('data-room')); break;\n" +
  "      case 'fam-sender-role':   Controller.famSetRole(el.getAttribute('data-role')); break;\n" +
  "      case 'fam-send':          Controller.famSend(); break;\n" +
  "      case 'fam-fold':          Controller.famFold(el.getAttribute('data-id')); break;\n" +
  "      case 'fam-edit':          Controller.famEdit(el.getAttribute('data-id')); break;\n" +
  "      case 'fam-save-edit':     Controller.famSaveEdit(el.getAttribute('data-id')); break;\n" +
  "      case 'fam-cancel-edit':   Controller.famCancelEdit(); break;\n" +
  "      case 'fam-translate':     Controller.famTranslate(el.getAttribute('data-id')); break;\n" +
  "      case 'fam-extract':       Controller.famExtract(el.getAttribute('data-id')); break;\n" +
  "      case 'fam-report':        Controller.famReport(el.getAttribute('data-id')); break;\n" +
      "      case 'fam-cmp-run':       Controller.famCmpRun(); break;\n" +
      "      case 'fam-retry':         Controller.famRetry(); break;\n" +
      "      case 'fam-switch-role':   Controller.famSwitchRole(); break;\n" +
      "      case 'fam-exit':         Controller.famExit(); break;\n" +
      "      case 'fam-subtab':       Controller.famSubtab(el.getAttribute('data-tab')); break;\n" +
      "      case 'fam-stance-set':    Controller.famStanceSet(el.getAttribute('data-item'), el.getAttribute('data-stance')); break;\n" +
      "      case 'fam-stance-submit': Controller.famStanceSubmit(el.getAttribute('data-item')); break;\n" +
      '      /* D-DOMAIN-CASES-END */';

html = html.replace('    switch (action) {', CASES_BLOCK);

/* ---------- 字节级自校验：注入块内容必须与源文件逐字节相同 ---------- */
const styleM = html.match(/<style id="d-domain">([\s\S]*?)<\/style>/);
const scriptM = html.match(/<script id="d-domain">([\s\S]*?)<\/script>/);
must(styleM, '未找到 <style id="d-domain"> 注入块');
must(styleM[1] === cssRaw, '样式注入块与 domain-d/app.css 逐字节不一致');
must(scriptM, '未找到 <script id="d-domain"> 注入块');
must(scriptM[1] === jsRaw, '脚本注入块与 domain-d/app.js 逐字节不一致');

/* 注入后 D 域块必须各恰为 1 个（避免重复注入） */
must(countRe(html, /<style id="d-domain">/g) === 1, 'd-style 块数量异常');
must(countRe(html, /<script id="d-domain">/g) === 1, 'd-script 块数量异常');

/* ============================================================================
 * ★ 落盘前语法门禁：每一段内联 <script> 都必须能真实编译
 * ---------------------------------------------------------------------------
 * 血泪教训（2026-10-12）：上面的「字节级自校验」只能证明**文本一致**，
 * 证明不了**代码可运行**。当时 valid 数组被拼成 comma expression，
 * 字节自检通过、上游 _accept19.js 静态门禁 19 项也全绿，
 * 但主脚本整块 SyntaxError → Controller/UI/API/State 全部未定义 → 整站白屏。
 * 所以这里补一道真实编译（vm.Script，只编译不执行）：
 * 任一内联脚本块编译失败 → must 抛错 → 整体不落盘。
 * ========================================================================== */
const vm = require('vm');
let inlineBlocks = 0;
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1] || '';
  const code = m[2] || '';
  if (/\bsrc\s*=/.test(attrs) || code.trim() === '') continue;   // 外链 / 空块跳过
  inlineBlocks++;
  try {
    new vm.Script(code, { filename: 'inline-block-' + inlineBlocks + '.js' });
  } catch (e) {
    must(false, '第 ' + inlineBlocks + ' 段内联脚本语法错误：' + e.message);
  }
}
must(inlineBlocks >= 2, '内联脚本块数异常（期望 >= 2，实际 ' + inlineBlocks + '）');

/* ---------- ★ 幂等自证：对本轮注入结果再回滚一次，必须逐字节还原出注入前的原文 ----------
 * 这条断言是为了堵住「看起来幂等、实际只能跑一次」这一类缺陷：
 * 注入引入的换行若没被回滚吃掉，第二次运行锚点就会失配。
 * 同一进程内做往返比对，比"跑两次再人工 diff"更省事、也不可能被跳过。 */
must(rollbackD(html) === origHtml, '幂等自证失败：对本轮注入结果回滚，未能逐字节还原出注入前的原文');

/* ---------- 落盘 ---------- */
fs.writeFileSync(HTML_PATH, html, 'utf8');
console.log('[inject] OK —— index.html 已注入 D 域（css ' + cssRaw.length + 'B / js ' + jsRaw.length
  + 'B），字节自检 + 语法门禁（' + inlineBlocks + ' 段内联脚本）全部通过。');
