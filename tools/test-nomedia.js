'use strict';

/**
 * 无图模式判定测试（纯 Node，不需要浏览器）
 * 用法：node tools/test-nomedia.js
 *
 * 这一层只验判定与记账：哪些资源该拦、哪些必须放行（放行错了页面会坏）、
 * 放行状态的生命周期、计数台账。
 *
 * 真正「拦下去之后请求是不是真的没发出去」由 tools/test-mobile-electron.js
 * 在真实 Electron 里验 —— 那一段 jsdom 够不着。
 */

const path = require('path');

const N = require(path.join(__dirname, '..', 'src', 'main', 'nomedia.js'));
const { NoMedia, LEVELS, LEVEL_TYPES, PLACEHOLDER_CSS, PLACEHOLDER_JS, normalizeLevel, isKept } = N;

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/** 造一条 webRequest details */
const req = (url, resourceType, webContentsId = 7) => ({ url, resourceType, webContentsId });

/* ---------------- */

console.log('\n[A] 档位');

check('三个档位', LEVELS.join(',') === 'off,image,image-av', LEVELS.join(','));
check('off 档不拦任何类型', LEVEL_TYPES.off.length === 0);
check('image 档只拦图片', LEVEL_TYPES.image.join(',') === 'image');
check('image-av 档多拦音视频', LEVEL_TYPES['image-av'].join(',') === 'image,media');
check('font 不在任何档的拦截名单里', !Object.values(LEVEL_TYPES).flat().includes('font'));
check('非法档位退回 off', normalizeLevel('bogus') === 'off');
check('合法档位原样保留', normalizeLevel('image-av') === 'image-av');

/* ---------------- */

console.log('\n[B] 判定：该拦的');

{
  const nm = new NoMedia({ level: 'image' });
  check('图片拦下', nm.shouldBlock(req('https://a.com/p.jpg', 'image')) === 'image');
  check('音视频在 image 档不拦', nm.shouldBlock(req('https://a.com/v.mp4', 'media')) === null);
  check('脚本不归它管', nm.shouldBlock(req('https://a.com/a.js', 'script')) === null);
  check('XHR 不归它管', nm.shouldBlock(req('https://a.com/api', 'xhr')) === null);
  check('样式表不归它管', nm.shouldBlock(req('https://a.com/a.css', 'stylesheet')) === null);
  check('主文档不归它管', nm.shouldBlock(req('https://a.com/', 'mainFrame')) === null);
  check('子框架不归它管', nm.shouldBlock(req('https://a.com/f', 'subFrame')) === null);
}

{
  const nm = new NoMedia({ level: 'image-av' });
  check('图片拦下', nm.shouldBlock(req('https://a.com/p.jpg', 'image')) === 'image');
  check('视频拦下', nm.shouldBlock(req('https://a.com/v.mp4', 'media')) === 'media');
  check('返回的是 resourceType 而不是 true', nm.shouldBlock(req('https://a.com/v.mp4', 'media')) === 'media');
}

{
  const nm = new NoMedia({ level: 'off' });
  check('off 档图片放行', nm.shouldBlock(req('https://a.com/p.jpg', 'image')) === null);
  check('off 档视频放行', nm.shouldBlock(req('https://a.com/v.mp4', 'media')) === null);
  check('off 档 enabled 为假', nm.enabled === false);
}

/* ---------------- */

console.log('\n[C] 判定：必须放行的');

{
  const nm = new NoMedia({ level: 'image-av' });
  const keep = [
    'https://a.com/favicon.ico',
    'https://a.com/assets/favicon.png',
    'https://a.com/favicon-32x32.png',
    'https://a.com/static/site.ico',
    'https://a.com/apple-touch-icon/favicon.svg'
  ];
  for (const u of keep) {
    check('放行 ' + u.replace('https://a.com', ''), nm.shouldBlock(req(u, 'image')) === null);
  }
}

{
  const nm = new NoMedia({ level: 'image' });
  check('普通 .ico 之外的同缀仍拦', nm.shouldBlock(req('https://a.com/photo.icofake', 'image')) === 'image');
  check('png 不被 favicon 规则误放', nm.shouldBlock(req('https://a.com/banner.png', 'image')) === 'image');
  check('isKept 对 favicon 为真', isKept('https://a.com/favicon.ico') === true);
  check('isKept 对普通图为假', isKept('https://a.com/1.png') === false);
}

{
  // 浏览器自己的界面（设置页、嗅探页预览）也在发请求，不算「页面里的内容」
  const nm = new NoMedia({ level: 'image-av', isInternal: (id) => id === 99 });
  check('内建界面图片放行', nm.shouldBlock(req('https://a.com/p.jpg', 'image', 99)) === null);
  check('内建界面视频放行', nm.shouldBlock(req('https://a.com/v.mp4', 'media', 99)) === null);
  check('普通标签页照拦', nm.shouldBlock(req('https://a.com/p.jpg', 'image', 7)) === 'image');
}

/* ---------------- */

console.log('\n[D] 放行机制');

{
  const nm = new NoMedia({ level: 'image' });
  check('放行前拦下', nm.shouldBlock(req('https://a.com/p.jpg', 'image', 7)) === 'image');

  nm.allowPage(7);
  check('整页放行后图片放行', nm.shouldBlock(req('https://a.com/p.jpg', 'image', 7)) === null);
  check('整页放行不影响别的标签页', nm.shouldBlock(req('https://a.com/p.jpg', 'image', 8)) === 'image');
  check('isPageAllowed 如实反映', nm.isPageAllowed(7) === true && nm.isPageAllowed(8) === false);

  nm.clear(7);
  check('clear 之后重新拦下', nm.shouldBlock(req('https://a.com/p.jpg', 'image', 7)) === 'image');
  check('clear 之后 isPageAllowed 为假', nm.isPageAllowed(7) === false);
}

{
  const nm = new NoMedia({ level: 'image' });
  nm.allowUrl(7, 'https://a.com/hero.jpg');
  check('点名放行的那一条过', nm.shouldBlock(req('https://a.com/hero.jpg', 'image', 7)) === null);
  check('同页其它图照拦', nm.shouldBlock(req('https://a.com/other.jpg', 'image', 7)) === 'image');
  check('点名放行不跨标签页', nm.shouldBlock(req('https://a.com/hero.jpg', 'image', 8)) === 'image');
  nm.clearAll();
  check('clearAll 清掉点名放行', nm.shouldBlock(req('https://a.com/hero.jpg', 'image', 7)) === 'image');
}

/* ---------------- */

console.log('\n[E] 台账');

{
  const nm = new NoMedia({ level: 'image-av' });
  check('判定本身不记账', (() => {
    nm.shouldBlock(req('https://a.com/a.jpg', 'image', 7));
    return nm.stats.blocked === 0;
  })());
  check('record 之后计数为 1', nm.record('image', 7) === 1);
  nm.record('image', 7);
  nm.record('media', 8);
  check('累计 3 条', nm.stats.blocked === 3);
  check('按类型分开计', nm.stats.byType.image === 2 && nm.stats.byType.media === 1);
  check('按标签页分开计', nm.byTab.get(7) === 2 && nm.byTab.get(8) === 1);
  check('snapshot 带上按页计数', nm.snapshot(7).tabBlocked === 2);
  check('snapshot 不传 id 时按页计数为 0', nm.snapshot().tabBlocked === 0);
  check('snapshot 带上档位名', nm.snapshot().label === '无图 + 视频');

  nm.clear(7);
  check('clear 顺带清掉该页计数', nm.snapshot(7).tabBlocked === 0);
  check('clear 不碰全局计数', nm.stats.blocked === 3);

  nm.resetStats();
  check('resetStats 归零', nm.stats.blocked === 0 && nm.byTab.size === 0);
}

{
  const nm = new NoMedia({ level: 'image' });
  const s = nm.snapshot();
  check('snapshot 没有「省了多少字节」这种编出来的字段',
        !('bytesSaved' in s) && !('savedBytes' in s) && !('saved' in s),
        Object.keys(s).join(','));
  check('snapshot 的类型列表是当前档位的',
        JSON.stringify(s.types) === JSON.stringify(['image']), JSON.stringify(s.types));
}

/* ---------------- */

console.log('\n[F] 配置变更');

{
  const nm = new NoMedia({ level: 'off' });
  check('初始关闭', nm.shouldBlock(req('https://a.com/p.jpg', 'image')) === null);
  nm.configure({ level: 'image' });
  check('configure 后立刻生效', nm.shouldBlock(req('https://a.com/p.jpg', 'image')) === 'image');
  nm.configure({ level: 'off' });
  check('再关掉又放行', nm.shouldBlock(req('https://a.com/p.jpg', 'image')) === null);
  nm.configure({});
  check('configure 不传 level 时不乱改', nm.level === 'off');
  nm.configure({ level: '不认识的档' });
  check('configure 遇到非法档位退回 off', nm.level === 'off');
}

/* ---------------- */

console.log('\n[G] 占位样式');

check('样式按 html.nova-no-image 作用域', PLACEHOLDER_CSS.includes('html.nova-no-image img'));
check('作用域类与注入脚本一致',
      PLACEHOLDER_JS.includes("classList.add('nova-no-image')"));
check('占位样式确实给了灰底', /background-color:\s*rgba/.test(PLACEHOLDER_CSS));
check('占位样式压掉了破图文字', /font-size:\s*0\s*!important/.test(PLACEHOLDER_CSS));
check('占位样式没有把字体也一起干掉', !/font-family/i.test(PLACEHOLDER_CSS));
check('占位样式提到 background-image', PLACEHOLDER_CSS.includes('background-image: none'));

/* ---------------- */

console.log('\n[H] 边界');

{
  const nm = new NoMedia({ level: 'image' });
  check('缺 webContentsId 不抛异常',
        nm.shouldBlock({ url: 'https://a.com/p.jpg', resourceType: 'image' }) === 'image');
  check('空 URL 不抛异常', nm.shouldBlock(req('', 'image')) === 'image');
  check('畸形 URL 不抛异常', nm.shouldBlock(req('http://[', 'image')) === 'image');
  check('不带 isInternal 也能工作', new NoMedia({ level: 'image' }).shouldBlock(req('x', 'image')) === 'image');
}

{
  // 关掉之后路径上应该一步都不多做 —— 这是「对性能零影响」的兑现方式
  const nm = new NoMedia({ level: 'off' });
  let touched = false;
  const trap = {
    get url() { touched = true; return 'https://a.com/p.jpg'; },
    get resourceType() { touched = true; return 'image'; },
    get webContentsId() { touched = true; return 7; }
  };
  nm.shouldBlock(trap);
  check('关闭时连 details 都不碰', touched === false);
}

console.log(`\n无图模式测试：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
process.exit(fail ? 1 : 0);
