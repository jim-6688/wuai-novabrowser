'use strict';
/**
 * 快捷登录回环域名白名单的匹配边界单测（Node，无需 Electron）。
 * 用法：node tools/test-local-auth-hosts.js
 *
 * 核心是「精确匹配 + 只收 localhost.*」：放行微信/QQ 客户端的回环域名，
 * 又绝不能把真正的公网站点（qq.com / weixin.qq.com / 仿冒域名）算进来。
 */
const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'main', 'local-auth-hosts.js'));

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
};

console.log('\n[A] 已知回环域名命中');
check('微信 localhost.weixin.qq.com', P.isLocalAuthHost('localhost.weixin.qq.com'));
check('微信 wechat.com 变体', P.isLocalAuthHost('localhost.wechat.com'));
check('QQ ptlogin2', P.isLocalAuthHost('localhost.ptlogin2.qq.com'));
check('QQ sec', P.isLocalAuthHost('localhost.sec.qq.com'));
check('QQ 通用', P.isLocalAuthHost('localhost.qq.com'));
check('大小写不敏感', P.isLocalAuthHost('LOCALHOST.Weixin.QQ.COM'));
check('末尾点容错', P.isLocalAuthHost('localhost.weixin.qq.com.'));
check('带端口（host 已去掉端口的场景容错）', P.isLocalAuthHost('localhost.weixin.qq.com'));

console.log('\n[B] 公网域名与仿冒域名不命中');
check('真正的公网站点 qq.com 不算', !P.isLocalAuthHost('qq.com'));
check('www.qq.com 不算', !P.isLocalAuthHost('www.qq.com'));
check('open.weixin.qq.com（授权页公网域名）不算', !P.isLocalAuthHost('open.weixin.qq.com'));
check('graph.qq.com 不算', !P.isLocalAuthHost('graph.qq.com'));
check('仿冒后缀 evilqq.com 不算', !P.isLocalAuthHost('evilqq.com'));
check('仿冒前缀 localhost.weixin.qq.com.evil.com 不算', !P.isLocalAuthHost('localhost.weixin.qq.com.evil.com'));
check('子域也不算（只精确匹配，不按后缀）', !P.isLocalAuthHost('x.localhost.weixin.qq.com'));
check('空串不算', !P.isLocalAuthHost(''));
check('undefined 不算', !P.isLocalAuthHost(undefined));

console.log('\n[C] 清单本身是可信的 localhost.*');
check('清单非空', P.LOCAL_AUTH_HOSTS.length > 0);
check('每一项都以 localhost. 开头', P.LOCAL_AUTH_HOSTS.every((h) => h.indexOf('localhost.') === 0));
check('没有任何主域通配项', P.LOCAL_AUTH_HOSTS.every((h) => h !== 'qq.com' && h !== 'weixin.qq.com' && h !== 'wechat.com'));

console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
process.exit(fail ? 1 : 0);
