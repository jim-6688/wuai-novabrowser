'use strict';
/**
 * 第三方登录弹窗判定单测（Node，无需 Electron）
 * 用法：node tools/test-auth-popup.js
 *
 * 覆盖 src/main/auth-popup.js 的纯逻辑：哪些 window.open 该开成真弹窗
 * （保留 window.opener，QQ/微信登录靠它回传结果），哪些该开成标签页。
 */
const path = require('path');
const A = require(path.join(__dirname, '..', 'src', 'main', 'auth-popup.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

console.log('\n[A] hostOf');
check('取主机名', A.hostOf('https://ptlogin2.qq.com/x?y=1') === 'ptlogin2.qq.com');
check('小写化', A.hostOf('https://Open.WeiXin.qq.com/a') === 'open.weixin.qq.com');
check('非法 URL 返回空', A.hostOf('not a url') === '');
check('空值返回空', A.hostOf('') === '');

console.log('\n[B] isAuthHost（标签边界后缀匹配）');
check('ptlogin2.qq.com 命中', A.isAuthHost('https://ptlogin2.qq.com/login'));
check('xui.ptlogin2.qq.com 命中（三级域）', A.isAuthHost('https://xui.ptlogin2.qq.com/cgi-bin/xlogin'));
check('graph.qq.com 命中', A.isAuthHost('https://graph.qq.com/oauth2.0/authorize'));
check('open.weixin.qq.com 命中', A.isAuthHost('https://open.weixin.qq.com/connect/qrconnect'));
check('login.taobao.com 命中', A.isAuthHost('https://login.taobao.com/member/login.jhtml'));
check('accounts.google.com 命中', A.isAuthHost('https://accounts.google.com/o/oauth2/auth'));
check('普通站点不命中', !A.isAuthHost('https://example.com/login'));
check('notqq.com 不能因为结尾像就命中', !A.isAuthHost('https://notqq.com/x'));
check('qq.com.evil.com 不能命中', !A.isAuthHost('https://qq.com.evil.com/x'));
check('空 URL 不命中', !A.isAuthHost(''));

console.log('\n[C] parseFeatures');
const f1 = A.parseFeatures('width=800,height=600');
check('读出宽高', f1.width === 800 && f1.height === 600);
check('标记 sized', f1.sized === true);
const f2 = A.parseFeatures('');
check('空串用默认尺寸', f2.width === A.DEFAULT_WIDTH && f2.height === A.DEFAULT_HEIGHT);
check('空串不算 sized', f2.sized === false);
const f3 = A.parseFeatures('width=100,height=100');
check('过小被抬到下限', f3.width === 320 && f3.height === 240);
const f4 = A.parseFeatures('width=9999,height=9999');
check('过大被压到上限', f4.width === 1400 && f4.height === 1100);
const f5 = A.parseFeatures('popup=yes');
check('popup=yes 被识别', f5.popup === true && f5.sized === false);
const f6 = A.parseFeatures('left=10,top=10,width=420,height=520,scrollbars=yes');
check('混杂参数也能读出宽高', f6.width === 420 && f6.height === 520);

console.log('\n[D] decide — 登录域名一律弹窗');
const d1 = A.decide({ url: 'https://ptlogin2.qq.com/login?x=1', disposition: 'new-window', features: '' });
check('QQ 登录无尺寸也开弹窗', d1.popup === true && d1.reason === 'auth-host');
const d2 = A.decide({ url: 'https://open.weixin.qq.com/connect/qrconnect', disposition: 'foreground-tab', features: '' });
check('微信扫码（foreground-tab）也开弹窗', d2.popup === true);
const d3 = A.decide({ url: 'https://graph.qq.com/oauth2.0/authorize', disposition: 'new-window', features: 'width=700,height=660' });
check('QQ 授权带尺寸，用站点给的尺寸', d3.popup === true && d3.width === 700 && d3.height === 660);

console.log('\n[E] decide — 普通链接仍开标签页');
const e1 = A.decide({ url: 'https://example.com/article', disposition: 'foreground-tab', features: '' });
check('target=_blank 普通链接 → 标签页', e1.popup === false && e1.reason === 'tab');
const e2 = A.decide({ url: 'https://example.com/x', disposition: 'background-tab', features: '' });
check('后台标签 → 标签页', e2.popup === false);
const e3 = A.decide({ url: 'https://example.com/x', disposition: 'new-window', features: '' });
check('window.open 无尺寸、非登录域名 → 标签页', e3.popup === false);

console.log('\n[F] decide — 带尺寸的普通弹窗');
const g1 = A.decide({ url: 'https://example.com/share', disposition: 'new-window', features: 'width=600,height=400' });
check('带尺寸的 window.open → 弹窗', g1.popup === true && g1.reason === 'sized-popup');
const g2 = A.decide({ url: 'https://example.com/share', disposition: 'new-window', features: 'popup=yes' });
check('popup=yes → 弹窗', g2.popup === true);

console.log('\n[G] decide — 开关与边界');
const h1 = A.decide({ url: 'https://ptlogin2.qq.com/login', disposition: 'new-window', features: '', allowAuthPopups: false });
check('关掉开关后登录域名也退回标签页', h1.popup === false && h1.reason === 'disabled');
check('空参数不炸', A.decide().popup === false);
check('url 为空不炸', A.decide({ url: '' }).popup === false);

console.log('\n[H] 常量自检');
check('登录域名表非空', Array.isArray(A.AUTH_HOSTS) && A.AUTH_HOSTS.length > 10);
check('默认尺寸合理', A.DEFAULT_WIDTH >= 400 && A.DEFAULT_HEIGHT >= 500);

console.log('\n[I] windowOptions（main.js 与 e2e 共用的开窗参数）');
const fakeSession = { __fake: 'session' };
const fakeParent = { __fake: 'window' };
const wo = A.windowOptions({ width: 640, height: 720 }, { session: fakeSession, parent: fakeParent });
check('宽高透传', wo.width === 640 && wo.height === 720);
check('隐藏菜单栏', wo.autoHideMenuBar === true);
check('禁用 Node 集成', wo.webPreferences.nodeIntegration === false);
check('开启上下文隔离', wo.webPreferences.contextIsolation === true);
check('开启沙箱', wo.webPreferences.sandbox === true);
check('共用 opener 的 session', wo.webPreferences.session === fakeSession);
check('挂到父窗口上', wo.parent === fakeParent);
const wo2 = A.windowOptions({}, {});
check('没有 session/parent 时不留空字段', !('parent' in wo2) && !('session' in wo2.webPreferences));
check('缺尺寸时用默认值', wo2.width === A.DEFAULT_WIDTH && wo2.height === A.DEFAULT_HEIGHT);
check('windowOptions 不炸空入参', !!A.windowOptions(null, null).webPreferences);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
