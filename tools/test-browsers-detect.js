'use strict';
/**
 * 浏览器检测与 Chromium 书签解析的测试
 * 用法：node tools/test-browsers-detect.js
 */
const path = require('path');
const BD = require(path.join(__dirname, '..', 'src', 'main', 'browsers-detect.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/* 构造一个 Chromium 书签 JSON（结构与 Chrome/Edge 实际文件一致） */
function chromiumDoc() {
  return {
    checksum: 'ignored',
    roots: {
      bookmark_bar: {
        name: '书签栏',
        type: 'folder',
        children: [
          { type: 'url', name: '知乎', url: 'https://www.zhihu.com/' },
          {
            type: 'folder', name: '工作',
            children: [
              { type: 'url', name: '内部看板', url: 'https://board.example.com/' },
              {
                // 再嵌一层，验递归不是只走一层
                type: 'folder', name: '更深',
                children: [{ type: 'url', name: '第三层', url: 'https://deep.example.com/' }]
              },
              // 文件夹节点自己是没有 url 的，硬取会得到 undefined
              { type: 'folder', name: '空文件夹', children: [] }
            ]
          }
        ]
      },
      other: {
        name: '其他书签',
        type: 'folder',
        children: [{ type: 'url', name: '别的', url: 'https://other.example.com/' }]
      },
      synced: { name: '移动设备', type: 'folder', children: [] }
    },
    meta_info: {}
  };
}

console.log('\n[A] Chromium 书签 JSON 解析');
{
  const items = BD.parseChromiumBookmarks(JSON.stringify(chromiumDoc()));
  const urls = items.map((i) => i.url);
  check('书签栏的条目读到了', urls.includes('https://www.zhihu.com/'));
  check('文件夹里的读到了（第一层）', urls.includes('https://board.example.com/'));
  check('嵌套文件夹里的也读到了（递归不止一层）', urls.includes('https://deep.example.com/'),
    urls.join(' '));
  check('「其他书签」也收了', urls.includes('https://other.example.com/'));
  check('文件夹节点没有被当成条目（它没有 url）',
    !items.some((i) => !i.url || !/^https?:/.test(i.url)));
  check('标题原样带出', items.find((i) => i.url.includes('zhihu')).title === '知乎');
}
{
  // 内部页必须滤掉 —— 那是 Chromium 塞在同一个文件里的
  const doc = chromiumDoc();
  doc.roots.bookmark_bar.children.push(
    { type: 'url', name: '设置页', url: 'chrome://settings/' },
    { type: 'url', name: '扩展页', url: 'chrome-extension://abc/popup.html' },
    { type: 'url', name: '文件', url: 'file:///C:/x.html' }
  );
  const urls = BD.parseChromiumBookmarks(doc).map((i) => i.url);
  check('chrome:// / chrome-extension:// / file:// 一律滤掉',
    !urls.some((u) => !/^https?:\/\//i.test(u)), urls.length + ' 条全是 http(s)');
}
{
  const doc = chromiumDoc();
  doc.roots.bookmark_bar.children.push({ type: 'url', name: '知乎重复', url: 'https://www.zhihu.com/' });
  doc.roots.other.children.push({ type: 'url', name: '斜杠不同', url: 'https://other.example.com' });
  const items = BD.parseChromiumBookmarks(doc);
  check('同一 URL 只留一条', items.filter((i) => i.url === 'https://www.zhihu.com/').length === 1);
  check('末尾斜杠不同算同一条',
    items.filter((i) => i.url.replace(/\/+$/, '') === 'https://other.example.com').length === 1,
    items.map((i) => i.url).join(' '));
}
{
  check('坏 JSON 返回空而不是抛异常（用户挑的是浏览器自己的文件，读坏了不能崩）',
    BD.parseChromiumBookmarks('{ 这不是 JSON').length === 0);
  check('缺 roots 时返回空', BD.parseChromiumBookmarks('{}').length === 0);
  check('空对象安全', BD.parseChromiumBookmarks(null).length === 0);
  check('已解析的对象也能直接传', BD.parseChromiumBookmarks(chromiumDoc()).length === 4);
}

/* ------------------------------------------------------------ 检测 */
console.log('\n[B] 检测');
{
  // 假的存在性判断：只有 Edge 的 Default 存在
  const exists = (p) => /Microsoft[\\/]Edge[\\/]User Data[\\/]Default[\\/]Bookmarks$/.test(p);
  const list = BD.detectBrowsers(exists);
  check('只列出装了的那些', list.length === 1 && list[0].id === 'edge', JSON.stringify(list.map((b) => b.id)));
  check('给了可读的路径', !!list[0].file && list[0].file.endsWith('Bookmarks'));
  check('标明可用', list[0].supported === true);
  check('支持的浏览器没有 note', !list[0].note);
}
{
  // Firefox：装了就列，但要标成不支持并给出路
  const exists = (p) => /Mozilla[\\/]Firefox[\\/]Profiles$/.test(p);
  const list = BD.detectBrowsers(exists);
  check('Firefox 装了会被列出来（不让它神秘消失）', list.length === 1 && list[0].id === 'firefox');
  check('但标明不支持', list[0].supported === false);
  check('并给出出路（请导出 HTML）', /导出为 HTML/.test(list[0].note || ''), list[0].note);
}
{
  const list = BD.detectBrowsers(() => false);
  check('一个都没装时返回空数组', list.length === 0);
}
{
  // 顺序：Chrome 应排在 Edge 前（装了两家时先列 Chrome）
  const exists = (p) => /[\\/](Google[\\/]Chrome|Microsoft[\\/]Edge)[\\/]/.test(p);
  const ids = BD.detectBrowsers(exists).map((b) => b.id);
  check('装了两家时 Chrome 排在 Edge 前',
    ids.indexOf('chrome') > -1 && ids.indexOf('edge') > -1
      && ids.indexOf('chrome') < ids.indexOf('edge'), ids.join(' '));
}
{
  check('非 Windows 上候选列表为空（这些路径全是 Windows 的）',
    process.platform === 'win32' ? BD.candidates().length > 0 : BD.candidates().length === 0);
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);