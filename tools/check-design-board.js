// 设计稿静态体检：
//   1. HTML 里用到的 class 是否都在 <style> 里定义过（防止改了标记忘了加样式，页面悄悄裸奔）
//   2. 画框清单与数量
//   3. 有没有 U+FFFD 替换字符（改文件时编码被打断的痕迹）
//   4. <style> / </style> 与 <div class="frame-wrap"> 的配对
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'design', 'design-board.html');
const s = fs.readFileSync(file, 'utf8');

let fail = 0;
const bad = (msg) => {
  console.log('★ ' + msg);
  fail++;
};

// ── 1. class 定义 vs 使用 ──────────────────────────────────────────
// 按 <style>…</style> 配对取内容：不能用 indexOf('<style')，它会命中注释里出现的同名文本
const defined = new Set();
const selRe = /\.(-?[A-Za-z_][\w-]*)/g;
let styleCount = 0;
for (const st of s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
  styleCount++;
  selRe.lastIndex = 0;
  let m;
  while ((m = selRe.exec(st[1]))) defined.add(m[1]);
}
if (!styleCount) bad('没找到 <style> 块');

// HTML 里用到的 class
const used = new Map();
for (const m of s.matchAll(/class="([^"]*)"/g)) {
  for (const c of m[1].split(/\s+/)) {
    if (c) used.set(c, (used.get(c) || 0) + 1);
  }
}

const missing = [...used.keys()].filter((c) => !defined.has(c)).sort();
console.log(`<style> 块 ${styleCount} 个 · 定义的选择器 ${defined.size} 个 · 用到的 class ${used.size} 个`);
if (missing.length) bad('用到但未定义: ' + missing.join(', '));
else console.log('✓ 所有用到的 class 都有定义');

// ── 2. 画框清单 ────────────────────────────────────────────────────
const caps = [...s.matchAll(/<div class="frame-cap"><b>([^<]+)<\/b>/g)].map((x) => x[1]);
const wraps = (s.match(/<div class="frame-wrap">/g) || []).length;
console.log(`\n画框 ${caps.length} 个（frame-wrap ${wraps} 个）：`);
caps.forEach((c) => console.log('  ' + c));
if (caps.length !== wraps) bad(`frame-cap ${caps.length} 个与 frame-wrap ${wraps} 个对不上`);

// ── 3. 损坏字符 ────────────────────────────────────────────────────
const fffd = (s.match(/�/g) || []).length;
if (fffd) bad(`有 ${fffd} 个 U+FFFD 替换字符（编码被打断过）`);
else console.log('\n✓ 没有 U+FFFD 替换字符');

// ── 4. 标签配对 ────────────────────────────────────────────────────
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'path', 'rect',
  'circle', 'line', 'polyline', 'polygon', 'use', 'stop', 'i']);
const stack = [];
let mismatch = 0;
let cm;
const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
while ((cm = tagRe.exec(s))) {
  const [, slash, tag, attrs, selfClose] = cm;
  if (VOID.has(tag) || selfClose || attrs.trim().endsWith('/')) continue;
  const line = s.slice(0, cm.index).split('\n').length;
  if (!slash) stack.push({ tag, line });
  else {
    const top = stack.pop();
    if (!top || top.tag !== tag) {
      bad(`第 ${line} 行 </${tag}> 与第 ${top ? top.line : '?'} 行的 <${top ? top.tag : '无'}>` +
        ` 不匹配`);
      mismatch++;
      if (mismatch > 5) break;
    }
  }
}
if (!mismatch && stack.length) bad(`${stack.length} 个标签未闭合: ` +
  stack.slice(0, 5).map((x) => `<${x.tag}> 行 ${x.line}`).join(' '));

console.log(`\n字节 ${Buffer.byteLength(s)} · 行 ${s.split('\n').length}`);
console.log(fail ? `\n✕ ${fail} 处问题` : '\n✓ 设计稿体检通过');
process.exit(fail ? 1 : 0);
