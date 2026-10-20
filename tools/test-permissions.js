'use strict';
/**
 * 站点权限纯函数单测（Node，无需 Electron / jsdom）。
 * 用法：node tools/test-permissions.js
 * 覆盖主进程 permissions.js 里「查规则 -> 决定 允许/禁止/询问」这一共用的纯逻辑。
 */
const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'main', 'permissions.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

// 示例规则集：example.com 与其子域共用规则，popups.com 只禁弹窗，
// both.com 摄像头与麦克风都允许（用于 decideMedia 的「两者都允许」用例）
const rules = [
  { host: 'maps.example.com', rules: { geolocation: 'allow' } },
  { host: 'example.com', rules: { geolocation: 'block', notifications: 'ask', camera: 'allow', microphone: 'block' } },
  { host: 'both.com', rules: { camera: 'allow', microphone: 'allow' } },
  { host: 'popups.com', rules: { popups: 'block' } }
];

console.log('\n[A] hostOf');
check('取主机名', P.hostOf('https://www.foo.com/path?x=1') === 'www.foo.com');
check('非法 url 返回空', P.hostOf('not a url') === '');
check('空返回空', P.hostOf('') === '');

console.log('\n[B] normalizePermission');
check('geolocation -> geolocation', P.normalizePermission('geolocation') === 'geolocation');
check('notifications -> notifications', P.normalizePermission('notifications') === 'notifications');
check('media -> media', P.normalizePermission('media') === 'media');
check('openExternal -> openExternal', P.normalizePermission('openExternal') === 'openExternal');
check('未知权限 -> null', P.normalizePermission('someWeirdThing') === null);

console.log('\n[C] matchHostRule（精确主机 → 逐级父域）');
check('精确命中', P.matchHostRule(rules, 'example.com').host === 'example.com');
check('子域命中父域规则', P.matchHostRule(rules, 'www.example.com').host === 'example.com');
check('更深子域也命中父域', P.matchHostRule(rules, 'a.b.example.com').host === 'example.com');
check('精确命中优先于父域', P.matchHostRule(rules, 'maps.example.com').host === 'maps.example.com');
check('无规则返回 null', P.matchHostRule(rules, 'nope.com') === null);
check('空规则集返回 null', P.matchHostRule([], 'example.com') === null);
check('大小写不敏感', P.matchHostRule(rules, 'EXAMPLE.COM').host === 'example.com');

console.log('\n[D] decide');
check('显式 allow', P.decide(rules, new Map(), 'example.com', 'camera') === 'allow');
check('显式 block', P.decide(rules, new Map(), 'example.com', 'geolocation') === 'block');
check('显式 ask -> ask', P.decide(rules, new Map(), 'example.com', 'notifications') === 'ask');
check('无规则 -> ask', P.decide(rules, new Map(), 'nope.com', 'geolocation') === 'ask');
check('父域规则对子域生效（ask）', P.decide(rules, new Map(), 'www.example.com', 'notifications') === 'ask');
check('会话内已选 allow 复用（无显式规则时）', P.decide(rules, new Map([['nope.com geolocation', true]]), 'nope.com', 'geolocation') === 'allow');
check('会话内已选 block 复用（无显式规则时）', P.decide(rules, new Map([['nope.com geolocation', false]]), 'nope.com', 'geolocation') === 'block');
check('会话选择优先于 ask 规则', P.decide(rules, new Map([['example.com notifications', true]]), 'example.com', 'notifications') === 'allow');

console.log('\n[E] decideMedia（摄像头 + 麦克风合并）');
check('两者都 allow -> allow', P.decideMedia(rules, new Map(), 'both.com') === 'allow');
check('麦克风 block -> block', P.decideMedia(rules, new Map(), 'example.com') === 'block');
check('无规则 -> ask', P.decideMedia(rules, new Map(), 'nope.com') === 'ask');
check('会话内麦克风允许仍受 block 规则压制', P.decideMedia(rules, new Map([['example.com microphone', true]]), 'example.com') === 'block');

console.log('\n[F] decidePopup');
check('显式 block -> block', P.decidePopup(rules, new Map(), 'popups.com') === 'block');
check('非 block 一律 allow（含缺失）', P.decidePopup(rules, new Map(), 'nope.com') === 'allow');
check('父域 block 对子域生效', P.decidePopup(rules, new Map(), 'www.popups.com') === 'block');

console.log('\n[G] CATEGORY_LABEL');
check('分类有中文标签', P.CATEGORY_LABEL.camera === '摄像头' && P.CATEGORY_LABEL.geolocation === '位置信息');

console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
process.exit(fail ? 1 : 0);
