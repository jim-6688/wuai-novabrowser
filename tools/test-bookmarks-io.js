'use strict';
/**
 * 书签导入导出的测试
 * 用法：node tools/test-bookmarks-io.js
 *
 * 测的是最容易写错也最难肉眼发现的部分：HTML 解析（实体、标签混入、
 * 单双引号）、去重规则（按完整 URL 而非主机名）、合并时不覆盖本地标题。
 */
const path = require('path');
const assert = require('assert');
const IO = require(path.join(__dirname, '..', 'src', 'main', 'bookmarks-io.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/* ---------------------------------------------------------------- 导出 */
console.log('\n[A] 导出');
{
  const doc = IO.buildExport([
    { title: '知乎', url: 'https://www.zhihu.com/', favicon: 'data:image/png;base64,AAA' },
    { title: '  ', url: 'https://example.com/' },
    { title: '坏数据', url: '' },          // 没地址，丢掉
    null,
    { title: '无标题', url: 'https://a.test/' }
  ], '1.0.0');

  check('带上了格式标记与版本', doc.format === IO.FORMAT && doc.version === IO.FORMAT_VERSION);
  check('带上了应用版本（便于日后排查）', doc.appVersion === '1.0.0');
  check('空地址的条目被丢掉', doc.count === 3 && doc.bookmarks.length === 3, doc.count + ' 条');
  check('标题为空时退回用地址当标题',
    doc.bookmarks[1].title === 'https://example.com/', doc.bookmarks[1].title);
  check('有 favicon 才带这个字段', !!doc.bookmarks[0].favicon && !('favicon' in doc.bookmarks[1]));
  check('标题两端的空白被去掉', doc.bookmarks[0].title === '知乎');
  check('count 与实际条数一致', doc.count === doc.bookmarks.length);
  // 导出文件必须能被自己的导入读回来
  const back = IO.parseImport(JSON.stringify(doc));
  check('导出→导入能原样读回', back.items.length === 3 && back.items[0].url === 'https://www.zhihu.com/');
}

/* ---------------------------------------------------------------- 导入自家 JSON */
console.log('\n[B] 导入自家 JSON');
{
  const r = IO.parseImport(JSON.stringify({
    format: IO.FORMAT, bookmarks: [{ title: 'A', url: 'https://a.test/' }]
  }));
  check('认出自家格式', r.items.length === 1 && r.items[0].title === 'A');
}
{
  const r = IO.parseImport(JSON.stringify([{ title: '裸数组', url: 'https://a.test/' }]));
  check('也接受裸数组', r.items.length === 1);
}
{
  const r = IO.parseImport('{ 这不是 JSON');
  check('坏 JSON 给出人话而不是抛异常', r.items.length === 0 && /解析不了/.test(r.reason), r.reason);
}
{
  const r = IO.parseImport(JSON.stringify({ format: 'x', 无书签列表: 1 }));
  check('结构不对时如实说明', r.items.length === 0 && /没有书签列表/.test(r.reason), r.reason);
}
{
  const r = IO.parseImport('   ');
  check('空文件有话说', r.items.length === 0 && /空/.test(r.reason), r.reason);
}

/* ---------------------------------------------------------------- 导入浏览器 HTML */
console.log('\n[C] 导入 Chrome / Edge 导出的 HTML');
{
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<DL><p>
    <DT><H3 ADD_DATE="1">书签栏</H3>
    <DL><p>
        <DT><A HREF="https://www.zhihu.com/" ADD_DATE="1">知乎</A>
        <DT><A HREF="https://zhuanlan.zhihu.com/p/123" ADD_DATE="2">知乎专栏：某篇文章 &amp; 笔记</A>
        <DT><A HREF='https://music.example.com/'>单引号也能认</A>
        <DT><A HREF=https://plain.example.com/>无引号也要认</A>
    </DL><p>
</DL><p>`;
  const r = IO.parseImport(html);
  check('四类写法都认出来', r.items.length === 4, r.items.map((i) => i.url).join(' '));
  check('双引号 href', r.items[0].url === 'https://www.zhihu.com/');
  check('单引号 href', r.items.some((i) => i.url === 'https://music.example.com/'));
  check('无引号 href', r.items.some((i) => i.url === 'https://plain.example.com/'));
  check('HTML 实体被解开（&amp;）',
    r.items.some((i) => i.title.includes('&') && !i.title.includes('&amp;')),
    r.items.find((i) => i.url.includes('zhuanlan')).title);
  check('标题里的标签被剥掉（<b> 之类）', (() => {
    const h2 = '<DT><A HREF="https://x.test/"><b>加粗标题</b></A>';
    const r2 = IO.parseImport(h2);
    return r2.items.length === 1 && r2.items[0].title === '加粗标题';
  })());
  check('目录名（<H3>）不会被当成书签', !r.items.some((i) => i.title.includes('书签栏')));
  // 层级只取平铺：整个 <DL> 树被线性扫一遍，文件夹本身不入库，
  // 但文件夹**里面的**书签都在（上面那 4 条里有 3 条在嵌套的 DL 内）。
  check('嵌套在文件夹里的书签也算数', r.items.length === 4, r.items.length + ' 条');
}
{
  const r = IO.parseImport('<!DOCTYPE html><html><body><p>这里面没有书签</p></body></html>');
  // 认得出是 HTML、但里面一条书签都没有 → 必须报错。
  // 静默返回 0 条的话界面会说「导入成功」，用户以为书签被清空了。
  check('认得出是 HTML 但没有书签时报错，不静默返回 0 条',
    r.items.length === 0 && /没找到书签/.test(r.reason), r.reason);
}
{
  const r = IO.parseImport('这是一段纯文本');
  check('完全认不出的格式也报错', r.items.length === 0 && /认不出/.test(r.reason), r.reason);
}

/* ---------------------------------------------------------------- 清洗与去重 */
console.log('\n[D] 清洗与去重');
{
  const r = IO.normalize([
    { url: 'https://a.test/', title: 'x' },
    { url: 'https://a.test/', title: 'y' },      // 完全重复
    { url: 'https://a.test', title: 'z' },        // 末尾斜杠不同 → 算重复
    { url: 'ftp://a.test/', title: 'w' },        // 不是 http(s)
    { url: 'javascript:alert(1)', title: 'e' },  // 危险协议
    { title: '没地址', url: '' },
    null
  ]);
  check('同一 URL 只留一条', r.items.length === 1, r.items.length + ' 条');
  check('末尾斜杠不同也算同一条', r.items[0].url === 'https://a.test/');
  check('非 http(s) 协议一律拒收', !r.items.some((i) => i.url.startsWith('ftp:')));
  check('javascript: 这类协议被拒（这是导入的第一道闸）',
    !r.items.some((i) => i.url.startsWith('javascript:')));
  check('如实报告跳过了几条', r.skipped === 6, r.skipped + ' 条');
}
{
  // 同一家、不同路径：两条都留。这是用户的真实收藏，不替他做决定。
  const r = IO.normalize([
    { url: 'https://zhihu.com/question/1', title: '问题一' },
    { url: 'https://zhihu.com/question/2', title: '问题二' },
    { url: 'https://zhuanlan.zhihu.com/p/1', title: '专栏' }
  ]);
  check('同一家不同路径全部保留', r.items.length === 3, r.items.length + ' 条');
}

/* ---------------------------------------------------------------- 合并 */
console.log('\n[E] 合并到现有书签');
{
  const m = IO.merge(
    [{ url: 'https://a.test/', title: '我改过的名字' }],
    [{ url: 'https://a.test/', title: '旧名字' }, { url: 'https://b.test/', title: '新来的' }]
  );
  check('已存在的算重复', m.dup === 1 && m.added === 1,
    `加 ${m.added} / 重复 ${m.dup}`);
  check('不覆盖本地改过的标题',
    m.merged[0].title === '我改过的名字', m.merged[0].title);
  check('新的一条接在后面', m.merged[1].url === 'https://b.test/');
  check('总数正确', m.merged.length === 2);
}
{
  const m = IO.merge(null, [{ url: 'https://a.test/', title: 'A' }]);
  check('原本没有书签也能导入', m.merged.length === 1);
}
{
  const m = IO.merge([{ url: 'https://a.test/' }], null);
  check('导入空列表不丢原有', m.merged.length === 1 && m.added === 0);
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);