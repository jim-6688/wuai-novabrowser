'use strict';

/**
 * 媒体嗅探页行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-sniffer-ui.js
 *
 * 这一层验证界面：分类计数对不对、置信度标签有没有如实标、
 * 流媒体有没有被区别对待（不给预览、单独提示）、分片有没有默认折叠、
 * 开关与最小体积有没有写回配置、下载/复制/清空有没有接到正确的桥上。
 *
 * 判定逻辑本身由 tools/test-sniffer.js 在纯 Node 下验证（那里能覆盖上百种格式组合），
 * 主进程的响应头解析由真实 Electron 验证 —— 那一段 jsdom 够不着。
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

  const waitFor = async (sel, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if ($(sel)) return true;
      await sleep(30);
    }
    return false;
  };

  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const openSniff = async () => {
    window.eval("openSettings('sniffer')");
    await waitFor('.sn-engine');
    await sleep(30);
  };

  /* 记录所有写回配置的调用，用来断言「哪些开关该落盘、哪些不该」 */
  const patchCalls = [];
  const origPatch = window.nova.settings.patch;
  window.nova.settings.patch = async (p) => { patchCalls.push(p); return origPatch(p); };

  /* ---------------- */

  console.log('\n[A] 嗅探分区渲染');

  await openSniff();
  check('设置页切到「媒体嗅探」分区', $('#sv-path').textContent === '媒体嗅探', $('#sv-path').textContent);
  check('左导航「媒体嗅探」项高亮', $('.sv-nav-item.is-active').dataset.sec === 'sniffer');
  check('渲染出引擎状态卡', !!$('.sn-engine'));
  check('引擎卡标注「运行中」', $('.sn-engine .sn-pill').textContent.trim() === '运行中',
    $('.sn-engine .sn-pill').textContent.trim());
  check('工具栏有嗅探按钮', !!$('#btn-sniff'));
  check('统计卡 5 格', $$('.sn-stat').length === 5, `实际 ${$$('.sn-stat').length}`);

  console.log('\n[B] 分类计数');

  const statOf = (label) => {
    const box = $$('.sn-stat').find((s) => s.querySelector('span').textContent === label);
    return box ? Number(box.querySelector('b').textContent) : NaN;
  };
  check('视频计数 = 4（含无扩展名靠 MIME 识别的那条）', statOf('视频') === 4, String(statOf('视频')));
  check('音频计数 = 1', statOf('音频') === 1, String(statOf('音频')));
  check('流媒体计数 = 1', statOf('流媒体') === 1, String(statOf('流媒体')));
  check('字幕计数 = 1', statOf('字幕') === 1, String(statOf('字幕')));
  check('合计体积已算出（非「—」）', statOf('合计体积') >= 0 || /[KMG]B/.test($$('.sn-stat')[4].textContent),
    $$('.sn-stat')[4].textContent);

  check('★ 工具栏角标只数非分片（7，不含 4 条分片）',
    $('#sniff-count').textContent === '7', $('#sniff-count').textContent);

  console.log('\n[C] 分组与条目');

  check('按类别分组出现 4 个分组标题', $$('.panel-label').filter((p) => /（\d+）/.test(p.textContent)).length >= 4,
    $$('.panel-label').map((p) => p.textContent.trim()).filter((t) => /（\d+）/.test(t)).join(' | '));
  check('主列表渲染 7 条（分片不在其中）', $$('.sn-item').length === 7, `实际 ${$$('.sn-item').length}`);
  check('每类都有对应的颜色徽标', $$('.sn-kind.is-video').length === 4
    && $$('.sn-kind.is-audio').length === 1
    && $$('.sn-kind.is-stream').length === 1
    && $$('.sn-kind.is-subtitle').length === 1,
    `video=${$$('.sn-kind.is-video').length} audio=${$$('.sn-kind.is-audio').length}`);

  console.log('\n[D] 判定依据与置信度如实呈现');

  const confTexts = $$('.sn-conf').map((c) => c.textContent.trim());
  check('MIME 直接命中的标「确定」', confTexts.filter((t) => t === '确定').length === 6,
    `确定×${confTexts.filter((t) => t === '确定').length}`);
  check('★ octet-stream + 扩展名的标「存疑」（不冒充确定）', confTexts.includes('存疑'), confTexts.join(','));
  check('每条都给出判定依据', $$('.sn-item-why').length === 7);
  check('判定依据文案具体可读', /响应类型|扩展名|二进制类型/.test($$('.sn-item-why')[0].textContent),
    $$('.sn-item-why')[0].textContent.trim());

  console.log('\n[E] 流媒体被区别对待');

  const streamItem = $$('.sn-item').find((i) => i.querySelector('.sn-kind.is-stream'));
  check('流媒体条目存在', !!streamItem);
  check('★ 流媒体不给「预览」按钮（会拉起整条流）',
    ![...streamItem.querySelectorAll('[data-sn]')].some((b) => b.dataset.sn === 'preview'));
  check('流媒体单独提示「分片清单」', !!streamItem.querySelector('.sn-stream-note'));
  check('提示里说明不能直接当文件下载', /分片清单/.test(streamItem.querySelector('.sn-stream-note').textContent));
  check('流媒体仍给下载按钮（下的是清单本身）',
    [...streamItem.querySelectorAll('[data-sn]')].some((b) => b.dataset.sn === 'download'));

  console.log('\n[F] 分片默认折叠');

  const segLabel = () => $$('.panel-label').find((p) => /HLS 分片/.test(p.textContent));
  check('分片分组标题显示总数 4', !!segLabel() && /（4）/.test(segLabel().textContent),
    segLabel() ? segLabel().textContent.trim() : '未找到');
  check('★ 默认不展开分片', $$('.sn-item.is-seg').length === 0, `实际 ${$$('.sn-item.is-seg').length}`);
  click([...segLabel().querySelectorAll('[data-sn]')].find((b) => b.dataset.sn === 'toggle-segs'));
  await sleep(30);
  check('点「展开」后分片出现', $$('.sn-item.is-seg').length === 4, `实际 ${$$('.sn-item.is-seg').length}`);
  const segLabel2 = () => $$('.panel-label').find((p) => /HLS 分片/.test(p.textContent));
  click([...segLabel2().querySelectorAll('[data-sn]')].find((b) => b.dataset.sn === 'toggle-segs'));
  await sleep(30);
  check('再点一次收回去', $$('.sn-item.is-seg').length === 0);

  console.log('\n[G] 嗅探设置');

  const swOf = (key) => $(`[data-sncfg="${key}"]`);
  check('三个设置开关都在', !!swOf('enabled') && !!swOf('autoProbe') && !!swOf('showSegments'));

  patchCalls.length = 0;
  click(swOf('enabled'));
  await sleep(30);
  check('关闭嗅探写回了配置', patchCalls.some((p) => p.sniffer && p.sniffer.enabled === false),
    JSON.stringify(patchCalls));
  check('关闭后状态标为「已关闭」', $('.sn-engine .sn-pill').textContent.trim() === '已关闭');
  check('关闭后列表给出说明而不是假装有数据', /嗅探已关闭/.test($('.sn-body, #settings-body').textContent));

  click($('[data-sncfg="enabled"]'));
  await sleep(30);
  check('重新打开恢复「运行中」', $('.sn-engine .sn-pill').textContent.trim() === '运行中');

  patchCalls.length = 0;
  click($('[data-sncfg="showSegments"]'));
  await sleep(30);
  // 断言的是「意图」而不是「这一段窗口里一条 patch 都没有」：
  // 启动时那次 persistSession() 是 400ms 防抖的（会话落盘），落点会漂移，
  // 偶尔正好落在这个 30ms 窗口里，把断言打成假红。要验的是
  // 「showSegments 这个纯界面开关不会被写进配置」，那就只盯这一项。
  check('★「显示分片」是纯界面开关，不写配置',
    !patchCalls.some((p) => p.sniffer && 'showSegments' in p.sniffer),
    JSON.stringify(patchCalls));
  check('但界面确实展开了分片', $$('.sn-item.is-seg').length === 4, `实际 ${$$('.sn-item.is-seg').length}`);
  click($('[data-sncfg="showSegments"]')); // 点回去，免得影响后续断言
  await sleep(30);
  check('再点一次收回分片', $$('.sn-item.is-seg').length === 0);

  patchCalls.length = 0;
  click($('[data-sncfg="autoProbe"]'));
  await sleep(30);
  check('「自动读取元数据」写回了配置', patchCalls.some((p) => p.sniffer && p.sniffer.autoProbe === false));
  click($('[data-sncfg="autoProbe"]'));
  await sleep(30);

  console.log('\n[H] 最小体积分段');

  const minBtns = $$('#sn-minsize button');
  check('四档可选', minBtns.length === 4, `实际 ${minBtns.length}`);
  check('第一档文案是「不限」', minBtns[0].textContent.trim() === '不限', minBtns[0].textContent.trim());
  check('默认选中「不限」', minBtns[0].classList.contains('is-active'));
  patchCalls.length = 0;
  click(minBtns[2]);
  await sleep(30);
  check('选 256 KB 写回配置', patchCalls.some((p) => p.sniffer && p.sniffer.minSizeKB === 256),
    JSON.stringify(patchCalls));
  check('选中态跟着切换', $$('#sn-minsize button')[2].classList.contains('is-active'));
  click($$('#sn-minsize button')[0]);
  await sleep(30);

  console.log('\n[I] 条目操作');

  const firstDl = $$('.sn-item')[0].querySelector('[data-sn="download"]');
  check('每条都有下载按钮', $$('.sn-item [data-sn="download"]').length === 7,
    `按钮 ${$$('.sn-item [data-sn="download"]').length} / 条目 ${$$('.sn-item').length}`);

  let created = null;
  const origCreate = window.nova.downloads.create;
  window.nova.downloads.create = async (opts) => { created = opts; return origCreate(opts); };

  click($$('.sn-item [data-sn="download"]')[0]);
  await sleep(40);
  check('点下载交给了多线程引擎', !!created && /^https?:/.test(created.url), JSON.stringify(created));
  check('★ 传了像样的文件名（不会只剩一个域名）', !!created && /\.\w{2,8}$/.test(created.filename || ''),
    created ? created.filename : '');

  /* 无扩展名的地址要能自动补上容器后缀，否则下载下来是个没有后缀的文件 */
  const noExtItem = $$('.sn-item').find((i) => /\/v1\/media\/8123/.test(i.querySelector('.sn-item-url').textContent));
  created = null;
  if (noExtItem) {
    click(noExtItem.querySelector('[data-sn="download"]'));
    await sleep(40);
    check('★ 无扩展名的地址被补上容器后缀', !!created && /\.mp4$/.test(created.filename || ''),
      created ? created.filename : '');
  } else {
    // 该条可能被体积排序挤走，退而验证函数本身
    check('无扩展名地址补后缀', window.eval("suggestName({url:'https://api.example.com/v1/media/8123',ext:'',container:'MP4'})") === '8123.mp4',
      window.eval("suggestName({url:'https://api.example.com/v1/media/8123',ext:'',container:'MP4'})"));
  }

  let copied = null;
  const origCopy = window.nova.system.copy;
  window.nova.system.copy = async (t) => { copied = t; return origCopy(t); };
  click($$('.sn-item [data-sn="copy"]')[0]);
  await sleep(30);
  check('点复制把地址送进了剪贴板桥', !!copied && /^https?:/.test(copied), String(copied));

  const previewBtn = $$('.sn-item [data-sn="preview"]')[0];
  check('可预览的条目给了预览按钮', !!previewBtn);
  click(previewBtn);
  await sleep(40);
  check('★ 展开预览后插入媒体元素', !!$('.sn-preview video') || !!$('.sn-preview audio'),
    $('.sn-preview') ? $('.sn-preview').innerHTML.slice(0, 60) : '无预览区');
  check('预览区带上「不带登录态」的说明', /登录态/.test($('.sn-preview-note').textContent));
  const opened = $$('.sn-item').find((i) => i.querySelector('.sn-preview'));
  check('★ 预览打开时不再自动重绘（否则播放会被打断）', (() => {
    const before = $$('.sn-item').length;
    window.eval('refreshSniffer()');
    return $$('.sn-item').length === before;
  })());
  click([...opened.querySelectorAll('[data-sn]')].find((b) => b.dataset.sn === 'preview'));
  await sleep(40);
  check('再点收起预览', !$('.sn-preview'));

  console.log('\n[J] 清空与角标');

  const clearBtn = $$('[data-sn="clear"]')[0];
  check('有清空按钮', !!clearBtn);
  click(clearBtn);
  await sleep(60);
  check('清空后条目归零', $$('.sn-item').length === 0, `实际 ${$$('.sn-item').length}`);
  check('角标同步归零', $('#sniff-count').textContent === '0', $('#sniff-count').textContent);
  check('空态给出引导文案', /还没有嗅到/.test($('#settings-body').textContent));

  console.log('\n[K] 未实现边界如实写明');

  const note = $('.sv-note');
  check('页面底部有边界说明', !!note);
  check('写明 blob:/MSE 拼出来的流嗅不到', /blob:|MSE/.test(note.textContent));
  check('写明加密 HLS 分片单独下下来也解不开', /EXT-X-KEY|加密/.test(note.textContent));

  console.log('\n[L] 运行时错误');

  check('全程无未捕获异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n嗅探页测试：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
  process.exit(fail ? 1 : 0);
})();
