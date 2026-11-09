/* 五牌密码 · 规则引擎穷举验证
 * 用法：node verify.js
 * 从 index.html 中抽出 <script id="engine-src"> 里的引擎，对全部 C(52,5)=2,598,960 手牌
 * 逐一手动验证编码 / 解码是否闭环。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

function grabScript(id) {
  const re = new RegExp('<script id="' + id + '">([\\s\\S]*?)<\\/script>');
  const m = html.match(re);
  if (!m) throw new Error('找不到 <script id="' + id + '">');
  return m[1];
}

/* --- 1. 语法检查：把页面里两段脚本都编译一遍 --- */
const engineSrc = grabScript('engine-src');
new vm.Script(engineSrc, { filename: 'engine.js' });

const allScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (allScripts.length < 2) throw new Error('页面里应有引擎与界面两段脚本');
allScripts.forEach((src, i) => new vm.Script(src, { filename: 'inline-' + i + '.js' }));
console.log('✓ 语法检查通过（共 ' + allScripts.length + ' 段内联脚本）');

/* --- 2. 载入引擎 --- */
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(engineSrc, ctx, { filename: 'engine.js' });
const E = ctx.window.FiveCardEngine;
if (!E) throw new Error('引擎未导出');

/* --- 3. 基本单元测试 --- */
const eq = E.eq, name = E.cardName;

(function unitTests() {
  // 全部 6 种排列都能被读回正确的数字
  const dummy = [E.makeCard(0, 0), E.makeCard(1, 0), E.makeCard(2, 0)]; // 小 中 大
  const digits = [];
  for (let d = 1; d <= 6; d++) {
    const perm = E.PERMS[d - 1];
    const shown = [E.makeCard(5, 0)].concat(perm.split('').map(k => dummy[+k]));
    const dec = E.decode(shown);
    if (dec.d !== d) throw new Error('排列 ' + perm + ' 读成 ' + dec.d + '，期望 ' + d);
    digits.push(dec.d);
  }
  // 环形计数（含绕回 K→A）：起点 K(13)，数 2 步 → A(1)、2 → 答案是 2
  const small = [E.makeCard(0, 1), E.makeCard(3, 1), E.makeCard(7, 1)]; // 小 中 大
  const perm2 = E.PERMS[1]; // '021' → 2 步
  const wrap = E.decode([E.makeCard(12, 0)].concat(perm2.split('').map(k => small[+k])));
  if (wrap.hv !== 2) throw new Error('绕回计算错误：' + wrap.hv);
  if (wrap.hiddenName !== '2♠') throw new Error('绕回花色/点数错误：' + wrap.hiddenName);
  console.log('✓ 六种排列 / 环形计数 / 绕回 均正确');
})();

/* --- 4. 穷举：所有五张牌组合 --- */
const deck = E.makeDeck();
const N = deck.length;
let hands = 0, encodings = 0, fail = 0;
const t0 = Date.now();
let firstFail = null;

for (let a = 0; a < N - 4; a++) {
  for (let b = a + 1; b < N - 3; b++) {
    for (let c = b + 1; c < N - 2; c++) {
      for (let d = c + 1; d < N - 1; d++) {
        for (let e = d + 1; e < N; e++) {
          const hand = [deck[a], deck[b], deck[c], deck[d], deck[e]];
          hands++;

          const opts = E.options(hand);
          if (!opts.length) { fail++; if (!firstFail) firstFail = { hand, why: '没有合法编码' }; continue; }

          const encs = E.encodeAll(hand);
          for (const enc of encs) {
            encodings++;
            const shown = enc.shown;
            const why = [];

            if (shown.length !== 4) why.push('亮牌不是 4 张');
            if (!eq(enc.shown[0], enc.base)) why.push('第一张不是基准牌');
            if (shown.some(x => eq(x, enc.hidden))) why.push('藏牌出现在亮牌里');
            if (shown.some((x, i) => shown.findIndex(y => eq(x, y)) !== i)) why.push('亮牌有重复');

            let dec;
            try { dec = E.decode(shown); } catch (err) { why.push('解码抛错：' + err.message); }
            if (dec) {
              if (!eq(dec.hidden, enc.hidden)) why.push('解码得到 ' + name(dec.hidden) + '，藏牌是 ' + name(enc.hidden));
              if (dec.d !== enc.d) why.push('步数不符');
              if (dec.suit !== enc.hidden.s) why.push('花色不符');
            }
            if (why.length) {
              fail++;
              if (!firstFail) firstFail = { hand: hand.map(name).join(' '), shown: shown.map(name).join(' '), why };
            }
          }
        }
      }
    }
  }
}
const ms = Date.now() - t0;

console.log('✓ 穷举完成：' + hands.toLocaleString() + ' 手牌 / ' + encodings.toLocaleString() + ' 种编码，用时 ' + (ms / 1000).toFixed(1) + 's');
if (fail) {
  console.error('✗ 失败 ' + fail + ' 例');
  if (firstFail) console.error(firstFail);
  process.exit(1);
}

/* --- 5. 随机抽样：任意摆法下 diagnose 必须与 decode 的结论一致 --- */
let tested = 0, bad = 0, rejected = 0;
for (let i = 0; i < 30000; i++) {
  const hand = E.draw(5);
  const enc = E.encode(hand);
  const rest = hand.filter(c => !eq(c, enc.hidden));
  for (let k = rest.length - 1; k > 0; k--) {           // 随机打乱另外四张
    const j = Math.floor(Math.random() * (k + 1));
    const t = rest[k]; rest[k] = rest[j]; rest[j] = t;
  }
  const truth = eq(E.decode(rest).hidden, enc.hidden);   // 这一摆法客观上对不对
  const r = E.diagnose(enc.hidden, rest);
  if (r.ok !== truth) bad++;
  if (!truth) { rejected++; if (!r.message) bad++; }
  tested++;
}
console.log('✓ 任意摆法一致性：' + tested + ' 次中 ' + rejected + ' 次被拒，异常 ' + bad + ' 次');
if (bad) process.exit(1);

/* --- 6. 抽样：所有合法编码都必须被判定成功 --- */
let sampleOk = 0;
for (let i = 0; i < 30000; i++) {
  const hand = E.draw(5);
  const enc = E.encode(hand);
  if (E.diagnose(enc.hidden, enc.shown).ok) sampleOk++;
}
console.log('✓ 正确摆法检测：' + sampleOk + '/30000 次判定成功');
if (sampleOk !== 30000) process.exit(1);

console.log('\n全部通过 ✅');
