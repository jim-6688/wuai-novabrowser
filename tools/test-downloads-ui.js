'use strict';

/**
 * 下载页行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-downloads-ui.js
 *
 * 这一层验证的是界面：分段进度条有没有按分片数画对、按钮给得对不对、
 * 点了之后有没有把设置写回去、节流重绘会不会把用户正在敲的地址弄丢。
 * 引擎本身的正确性由 tools/test-downloader.js 用真实 HTTP 服务器验证。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

function loadJsdom() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules')
  ];
  for (const dir of candidates) {
    const p = path.join(dir, 'jsdom');
    if (fs.existsSync(p)) return require(p);
  }
  try { return require('jsdom'); } catch { /* 继续 */ }
  console.error('\n缺少 jsdom（仅测试需要）。装法见 README。\n');
  process.exit(2);
}
const { JSDOM } = loadJsdom();

const root = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = await JSDOM.fromFile(path.join(root, 'src/renderer/shell.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  for (let i = 0; i < 60 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);

  /** 等某个选择器出现 */
  const waitFor = async (sel, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if ($(sel)) return true;
      await sleep(30);
    }
    return false;
  };

  const openDl = async () => {
    window.eval("openSettings('downloads')");
    await waitFor('.dl-engine');
    await sleep(30);
  };

  const stateDl = () => window.eval('JSON.stringify(state.downloads.map(t => ({id:t.id,state:t.state})))');

  console.log('\n[A] 下载分区渲染');

  await openDl();
  check('设置页切到「下载」分区', $('#sv-path').textContent === '下载', $('#sv-path').textContent);
  check('左导航「下载」项高亮', $('.sv-nav-item.is-active').dataset.sec === 'downloads');
  check('渲染出引擎状态卡', !!$('.dl-engine'));
  check('引擎卡标注「接管中」', $('.dl-engine .dl-pill').textContent.trim() === '接管中',
    $('.dl-engine .dl-pill').textContent.trim());
  check('引擎卡有 4 个统计格', $$('.dl-engine .dl-stat').length === 4,
    $$('.dl-engine .dl-stat').map((x) => x.querySelector('span').textContent).join('/'));
  check('统计格给出合计速度', /\/s/.test($$('.dl-engine .dl-stat b')[1].textContent),
    $$('.dl-engine .dl-stat b')[1].textContent);
  check('说明里如实披露不支持 Range 时的退化行为',
    /不支持 Range 时自动退化为单连接/.test($('.dl-engine-note').textContent));

  console.log('\n[B] 线程数与并发设置');

  const threadBtns = $$('#dl-threads button');
  check('线程数有 4 档：1 / 4 / 8 / 16', threadBtns.map((b) => b.textContent.trim()).join(',') === '1,4,8,16',
    threadBtns.map((b) => b.textContent.trim()).join(','));
  check('当前线程数 8 高亮', $('.segmented#dl-threads button.is-active').textContent.trim() === '8');
  const concBtns = $$('#dl-conc button');
  check('并发任务数有 4 档：1 / 2 / 3 / 5', concBtns.map((b) => b.textContent.trim()).join(',') === '1,2,3,5');
  check('当前并发 3 高亮', $('.segmented#dl-conc button.is-active').textContent.trim() === '3');

  $$('#dl-threads button').find((b) => b.textContent.trim() === '16')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  check('点 16 后写回设置', window.eval('state.settings.download.threads') === 16,
    String(window.eval('state.settings.download.threads')));
  check('高亮跟着换到 16', $('.segmented#dl-threads button.is-active').textContent.trim() === '16');

  $$('#dl-conc button').find((b) => b.textContent.trim() === '5')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  check('点 5 后并发数写回设置', window.eval('state.settings.download.maxConcurrent') === 5);

  console.log('\n[C] 接管开关');

  const sw = $('[data-dlcfg="takeOver"]');
  check('接管开关初始为开', sw.classList.contains('is-on'));
  sw.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  check('关闭后写回设置', window.eval('state.settings.download.takeOver') === false);
  await waitFor('.dl-engine');
  check('引擎卡改为「已关闭」', $('.dl-engine .dl-pill').textContent.trim() === '已关闭',
    $('.dl-engine .dl-pill').textContent.trim());
  check('关闭后说明文案同步（改成走 Chromium）',
    /Chromium 内建单连接下载器/.test($('.dl-engine-note').textContent));
  // 开回来，后面的用例还在接管态下
  $('[data-dlcfg="takeOver"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  check('再点一下恢复接管', window.eval('state.settings.download.takeOver') === true);

  console.log('\n[D] 任务列表：多线程 / 单连接 / 已完成 / 失败');

  await openDl();
  const tasks = $$('.dl-task');
  check('渲染出 4 条任务（样例数据）', tasks.length === 4, `实际 ${tasks.length}`);

  const multi = tasks[0];
  check('第一条是多线程任务：8 个分片格', multi.querySelectorAll('.dl-seg').length === 8,
    String(multi.querySelectorAll('.dl-seg').length));
  check('多线程任务标注「8 线程并发」', /8 线程并发/.test(multi.querySelector('.dl-meta').textContent),
    multi.querySelector('.dl-meta').textContent.trim());
  check('分段条里已完成的格子内部填满 100%',
    [...multi.querySelectorAll('.dl-seg.is-done b')].every((b) => parseFloat(b.style.width) >= 99.9),
    // 注意 jsdom 会把 "100.0%" 规范化成 "100%"，所以这里比数值不比字符串
    [...multi.querySelectorAll('.dl-seg.is-done b')].map((b) => b.style.width).join(','));
  check('分段条里在跑的格子是部分填充', [...multi.querySelectorAll('.dl-seg.is-active b')]
    .some((b) => parseFloat(b.style.width) > 0 && parseFloat(b.style.width) < 100));
  check('分段条的 flex-grow 按分片大小分配',
    [...multi.querySelectorAll('.dl-seg')].every((s) => parseFloat(s.style.flexGrow) > 0),
    [...multi.querySelectorAll('.dl-seg')].map((s) => s.style.flexGrow).join(','));
  check('多线程任务显示速度与剩余时间',
    /\/s/.test(multi.textContent) && /剩余/.test(multi.textContent));
  check('多线程任务显示进度百分比', /（\d+%）/.test(multi.querySelector('.dl-meta').textContent));

  const single = tasks[1];
  check('第二条是单连接任务：只有 1 个分片格', single.querySelectorAll('.dl-seg').length === 1);
  check('单连接任务如实标注（不假装多线程）',
    /单连接（服务端不支持分片）/.test(single.querySelector('.dl-meta').textContent),
    single.querySelector('.dl-meta').textContent.trim());

  const done = tasks[2];
  check('已完成任务状态徽标为 is-done', done.querySelector('.dl-pill').classList.contains('is-done'));
  check('已完成任务给出「打开」按钮', !!done.querySelector('[data-dl="open"]'));
  check('已完成任务给出「在文件夹中显示」', !!done.querySelector('[data-dl="show"]'));
  check('已完成任务给出「移除」', !!done.querySelector('[data-dl="remove"]'));
  check('已完成任务不再显示速度', !/\/s/.test(done.querySelector('.dl-meta').textContent));

  const bad = tasks[3];
  check('失败任务状态徽标为 is-error', bad.querySelector('.dl-pill').classList.contains('is-error'));
  check('失败任务把错误原因摊开显示', !!bad.querySelector('.dl-error')
    && /403/.test(bad.querySelector('.dl-error').textContent), bad.querySelector('.dl-error').textContent.trim());
  check('失败任务给出「重试」', !!bad.querySelector('[data-dl="retry"]'));

  console.log('\n[E] 进行中 / 历史分组');

  const sections = $$('.panel-label').map((x) => x.textContent.trim());
  check('任务按「进行中」与「已完成与历史」分组',
    sections.some((s) => /^进行中（2）/.test(s)) && sections.some((s) => /^已完成与历史（2）/.test(s)),
    sections.join(' | '));
  check('有「清除记录」按钮', !!$('[data-act="dl-clear"]'));

  console.log('\n[F] 新建下载');

  check('有新建下载输入框', !!$('#dl-url'));
  check('有开始下载按钮', !!$('[data-act="dl-start"]'));

  $('#dl-url').value = 'ftp://example.com/x.bin';
  window.eval("state.dlDraft = 'ftp://example.com/x.bin'");
  $('[data-act="dl-start"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  check('非法协议被拦下', /只支持 http/.test($('#toast').textContent), $('#toast').textContent);
  check('非法地址不进入列表', JSON.parse(stateDl()).length === 4);

  const before = JSON.parse(stateDl()).length;
  $('#dl-url').value = 'https://example.com/files/report-v2.pdf';
  window.eval("state.dlDraft = 'https://example.com/files/report-v2.pdf'");
  $('[data-act="dl-start"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  const after = JSON.parse(stateDl());
  check('合法地址加入列表', after.length === before + 1, `${before} -> ${after.length}`);
  check('新任务文件名从 URL 末段推出', after[0].id.startsWith('dl_preview_'));
  await waitFor('.dl-task');
  check('新任务渲染在列表里', /report-v2\.pdf/.test($('#settings-body').textContent));
  check('开始下载后清空输入框草稿', window.eval('state.dlDraft') === '',
    JSON.stringify(window.eval('state.dlDraft')));

  // 回车提交
  const input2 = $('#dl-url');
  input2.value = 'https://example.com/files/again.zip';
  input2.dispatchEvent(new window.Event('input', { bubbles: true }));
  input2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);
  check('在输入框里回车也能开始下载',
    JSON.parse(stateDl()).length === before + 2, String(JSON.parse(stateDl()).length));

  console.log('\n[G] 暂停 / 继续 / 移除 / 清除记录');

  await openDl();
  const pauseBtn = $('.dl-task [data-dl="pause"]');
  check('进行中的任务给出「暂停」', !!pauseBtn);
  const pausedId = pauseBtn.dataset.id;
  pauseBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  const afterPause = JSON.parse(stateDl()).find((t) => t.id === pausedId);
  check('点暂停后任务状态变为 paused', afterPause && afterPause.state === 'paused',
    JSON.stringify(afterPause));
  await waitFor('.dl-task');
  check('暂停后该任务出现「继续」按钮',
    !!$$(`.dl-task[data-task="${pausedId}"] [data-dl="resume"]`).length);

  $(`.dl-task[data-task="${pausedId}"] [data-dl="resume"]`)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  check('点继续后回到下载中',
    JSON.parse(stateDl()).find((t) => t.id === pausedId).state === 'downloading');

  await openDl();
  const removeBtn = $('.dl-task [data-dl="remove"]');
  const removeId = removeBtn.dataset.id;
  const nBefore = JSON.parse(stateDl()).length;
  removeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  check('点移除后任务从列表消失',
    JSON.parse(stateDl()).length === nBefore - 1 && !JSON.parse(stateDl()).some((t) => t.id === removeId));

  await openDl();
  $('[data-act="dl-clear"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  const left = JSON.parse(stateDl());
  check('清除记录只清掉已结束的，进行中/暂停的还在',
    left.every((t) => !['done', 'error', 'canceled'].includes(t.state)),
    left.map((t) => t.state).join(','));

  console.log('\n[H] 输入框草稿不被节流重绘冲掉');

  await openDl();
  const input3 = $('#dl-url');
  input3.value = 'https://example.com/half-typed';
  input3.dispatchEvent(new window.Event('input', { bubbles: true }));
  // 模拟下载进度事件触发的整页重绘
  window.eval("bridge.on && state.downloads.unshift(Object.assign({}, state.downloads[0]))");
  window.eval("refreshDownloads(true)");
  await sleep(200);
  check('重绘后输入框里的草稿还在', $('#dl-url').value === 'https://example.com/half-typed',
    JSON.stringify($('#dl-url').value));
  check('草稿同时留在 state.dlDraft 里',
    window.eval('state.dlDraft') === 'https://example.com/half-typed');

  /* Chromium 内建下载器那条路的**真实数据形状**：它只给字节数，
     没有 progress 这个比值（主进程那边原来也确实没写过它）。
     用户报的「进度条没有随百分比进度走」就是这一条：字节数在动、条子不动。
     所以这里刻意**不发 progress**，看渲染层能不能自己把比值兜出来。 */
  console.log('\n[H2] 只有字节数（没有 progress）时进度条也要走');

  const clickEl = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  window.nova.__emit('download:update', {
    id: 'native_probe', filename: 'big.iso', url: 'https://example.test/big.iso',
    total: 1000, received: 250, source: 'chromium', state: 'progressing'
  });
  // 小窗没开的话打开它（列表只在打开时才画）
  if ($('#dl-popover').hidden) clickEl($('#btn-downloads'));
  await sleep(450);

  const probeRow = $$('#dl-pop-list .dl-task')
    .find((r) => r.dataset.task === 'native_probe');
  check('小窗里出现了这条内建下载器的任务', !!probeRow);
  const probeBar = probeRow && probeRow.querySelector('.dl-seg b');
  check('进度条按 received / total 画出来了（不是 0% 宽）',
    probeBar && parseFloat(probeBar.style.width) > 24 && parseFloat(probeBar.style.width) < 26,
    probeBar ? probeBar.style.width : '没有进度条');
  check('旁边的百分比与条形一致', probeRow && /（25%）/.test(probeRow.textContent),
    probeRow ? probeRow.textContent.replace(/\s+/g, ' ').slice(0, 80) : '');

  // 再推一帧，确认它是跟着走的（不是渲染时算了一次就定住）
  window.nova.__emit('download:update', {
    id: 'native_probe', filename: 'big.iso', url: 'https://example.test/big.iso',
    total: 1000, received: 800, source: 'chromium', state: 'progressing'
  });
  await sleep(450);
  const probeBar2 = $$('#dl-pop-list .dl-task')
    .find((r) => r.dataset.task === 'native_probe').querySelector('.dl-seg b');
  check('下一帧推到 80%，条形也跟着变',
    parseFloat(probeBar2.style.width) > 79 && parseFloat(probeBar2.style.width) < 81,
    probeBar2.style.width);

  console.log('\n[I] 运行时错误');

  check('走完下载页全流程仍无异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  process.exit(2);
});
