'use strict';
const EE = require('../../services/emotionEngine');
const c = EE.corpus;
const out = [];
let nullAxis = 0, ok = 0, redline = 0;
const nullByDir = {}, nullSamples = [];
const bandWrong = [];
for (const e of c.entries || []) {
  const fv = EE.analyze(e.raw_text, e.direction);
  if (fv.red_line) { redline++; continue; }
  if (fv.axis === null) {
    nullAxis++;
    nullByDir[e.direction] = (nullByDir[e.direction] || 0) + 1;
    if (nullSamples.length < 6) nullSamples.push('[' + e.band + '|' + e.direction + '] ' + e.raw_text);
  } else {
    ok++;
    if (fv.band !== e.band && bandWrong.length < 8) bandWrong.push('entry.band=' + e.band + ' fv.band=' + fv.band + ' :: ' + e.raw_text);
  }
}
out.push('entries: ' + (c.entries || []).length + ' | axis=null: ' + nullAxis + ' | ok: ' + ok + ' | red_line: ' + redline);
out.push('null by direction: ' + JSON.stringify(nullByDir));
out.push('--- null 样本 ---');
for (const s of nullSamples) out.push(s);
out.push('--- band 误判样本（axis 非 null 但档不符）---');
for (const s of bandWrong) out.push(s);
console.log(out.join('\n'));
