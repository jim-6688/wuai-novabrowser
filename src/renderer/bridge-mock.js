'use strict';

/**
 * 桥接桩（Bridge Mock）
 * ---------------------------------------------------------------------------
 * 在 Electron 里运行时 window.nova 由 preload 注入，本文件什么都不做。
 * 在普通浏览器里打开 shell.html 时，本文件提供一份等价的桩实现 + 示例数据，
 * 让整套 UI（含移动端布局、面板、内核切换）可以直接点着看 —— 用于设计评审与前端联调。
 * 桩里的数字是样例数据，页面上会明确标注「UI 预览」，不会伪装成真实运行环境。
 */

if (typeof window !== 'undefined' && !window.nova) {
  document.documentElement.dataset.mode = 'preview';

  const now = Date.now();
  const listeners = new Map();

  /* 内核清单的最小复刻 —— 与 native/engines/manifest.json 同形，
     数值取自真实下载结果，好让 UI 预览看到的就是真状态。 */
  const kernelOf = (id) => ({
    chromium: {
      binariesReady: true, bridgeReady: false, arch: 'x64 (AMD64)', blocker: null,
      sources: [
        {
          id: 'chromium-electron', label: 'Electron 主内核', version: 'Electron 30.5.1',
          complete: true, sizeBytes: 266413849, fileCount: 73,
          signature: { valid: true, detected: 'Electron / Chromium', arch: 'x64 (AMD64)', exportCount: 3126, linkedAt: '2024-09-13' }
        },
        {
          id: 'chromium-cef', label: 'CEF 嵌入内核', version: 'CEF 154.0.34 / Chromium 154.0.8037.98',
          complete: true, sizeBytes: 441971376, fileCount: 972,
          signature: { valid: true, detected: 'CEF / Chromium Embedded', arch: 'x64 (AMD64)', exportCount: 249, linkedAt: '2026-09-30' }
        }
      ]
    },
    gecko: {
      binariesReady: true, bridgeReady: false, arch: 'x86 (I386)',
      blocker: '真内核二进制已就位（x86），缺原生宿主 native/bin/gecko-host.exe —— 需编译为 x86，见 native/README.md',
      sources: [
        {
          id: 'gecko-xulrunner45', label: 'GeckoFX 45 + XULRunner 45', version: 'GeckoFX 45.0.6.0 / XULRunner 45.0.0.5873',
          complete: true, sizeBytes: 77411238, fileCount: 32,
          signature: { valid: true, detected: 'Gecko / XULRunner (XPCOM)', arch: 'x86 (I386)', exportCount: 1847, linkedAt: '2016-01-30' }
        },
        {
          id: 'gecko-xulrunner41', label: 'Mozilla 官方 XULRunner', version: 'XULRunner 41.0.2 (win32, 官方归档)',
          complete: true, sizeBytes: 78387375, fileCount: 50,
          signature: { valid: true, detected: 'Gecko / XULRunner (XPCOM)', arch: 'x86 (I386)', exportCount: 1123, linkedAt: '2015-10-14' }
        }
      ]
    },
    trident: {
      binariesReady: true, bridgeReady: false, arch: 'x64 (AMD64)',
      blocker: '内核由系统 mshtml.dll 提供，缺原生宿主 native/bin/trident-host.exe —— 见 native/README.md',
      sources: [
        {
          id: 'trident-mshtml', label: 'Windows 内置 MSHTML', version: '系统组件（不下载）',
          complete: true, sizeBytes: 60756480, fileCount: 0,
          signature: { valid: true, detected: 'Trident / MSHTML (IE)', arch: 'x64 (AMD64)', exportCount: 22, linkedAt: '2020-11-30' }
        }
      ]
    }
  })[id];

  const engines = [
    {
      id: 'chromium', label: 'Chromium', vendor: 'Blink · 现代标准内核', short: 'CR',
      accent: '#3D6BFF', partition: 'persist:nova-chromium', mode: 'native', modeLabel: '原生内核',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      shim: null, capabilities: { crx: true, xpi: 'polyfill', adblock: true, devtools: true },
      notes: '进程内真实 Blink 渲染，插件与 DevTools 完整可用。', fallbackReason: null,
      kernel: kernelOf('chromium')
    },
    {
      id: 'gecko', label: 'Gecko', vendor: 'Firefox 内核', short: 'GK',
      accent: '#FF7139', partition: 'persist:nova-gecko', mode: 'compat', modeLabel: '兼容层',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
      shim: '/* gecko shim */',
      capabilities: { crx: 'polyfill', xpi: true, adblock: true, devtools: false },
      notes: '真内核 XULRunner 45 二进制已在 native/engines/gecko-xulrunner45（32 位，xul.dll 38MB）。尚缺原生宿主 native/bin/gecko-host.exe —— 必须编译为 x86。',
      fallbackReason: '真内核二进制已就位（x86）：GeckoFX 45.0.6.0 / XULRunner 45.0.0.5873、XULRunner 41.0.2 (win32, 官方归档)。尚缺原生宿主 native/bin/gecko-host.exe（需自行编译），编译前以兼容层渲染。',
      kernel: kernelOf('gecko')
    },
    {
      id: 'trident', label: 'IE / Trident', vendor: 'IE11 兼容内核', short: 'IE',
      accent: '#0A84C6', partition: 'persist:nova-trident', mode: 'compat', modeLabel: '兼容层',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; .NET4.0C; .NET4.0E; rv:11.0) like Gecko',
      shim: '/* trident shim */',
      capabilities: { crx: false, xpi: false, adblock: true, devtools: false },
      notes: 'Trident 不是可下载的独立程序 —— 它由系统 mshtml.dll 提供（已检测到，22MB）。尚缺原生宿主 native/bin/trident-host.exe。',
      fallbackReason: '内核由系统提供（x64）：Windows 内置 MSHTML。尚缺原生宿主 native/bin/trident-host.exe（需自行编译），编译前以兼容层渲染。',
      kernel: kernelOf('trident')
    }
  ];

  /* 内置新标签页的本地地址。预览里加载不了真实文件（没有 webview），
     但地址的形状要是对的 —— 外壳会拿它拼 ?theme=…&data=… 并据此判断
     「当前页是不是新标签页」。 */
  const NEWTAB_FILE_URL = 'file:///preview/newtab.html';

  const DEFAULTS = {
    homepage: 'https://52ta.top/',
    // 与 src/main/settings.js 的出厂值保持一致。这里要是还写成主页地址，
    // 预览里看到的默认档位就跟真机不一样了。
    newTabPage: 'start',
    ntpShortcuts: { added: [], removed: [] },
    searchTemplate: 'https://www.baidu.com/s?wd=%s',
    defaultEngine: 'chromium',
    layout: 'auto',
    theme: 'light',
    adblock: { enabled: true, cosmetic: true, level: 'standard' },
    restoreSession: true,
    session: { tabs: [], activeIndex: 0 },
    download: { takeOver: true, threads: 8, maxConcurrent: 3, dir: '' },
    sniffer: { enabled: true, minSizeKB: 0, showSegments: false, autoProbe: true },
    mobile: { noImage: 'off', autoPage: false, autoPageMax: 10 }
  };

  /* 格式注册表规模 —— 与 src/main/sniffer.js 实际算出来的一致，写死是为了
     预览模式下不必去 require 主进程代码。改动那边时记得同步这一行。 */
  const SNIFF_FORMATS = { extensions: 100, mimes: 91, containers: 78 };

  /**
   * 嗅探样例：刻意覆盖各种判定路径，好让界面上每种标签都能看到一次 ——
   * MIME 直接命中、无扩展名靠 MIME 救回、扩展名兜底、低置信度、
   * 流媒体清单、字幕、HLS 分片。
   * tabId 用 1：预览模式第一个标签页的 wcId 就取 1。
   */
  const sniffDemo = [
    {
      id: 'sn_demo_1', url: 'https://cdn.example.com/movie/trailer-1080p.mp4',
      normUrl: 'https://cdn.example.com/movie/trailer-1080p.mp4',
      kind: 'video', container: 'MP4', ext: 'mp4', mime: 'video/mp4',
      size: 48 * 1024 * 1024, confidence: 0.95, basis: 'mime', reason: '响应类型 video/mp4',
      downloadable: true, isSegment: false, hits: 2, tabId: 1,
      pageUrl: 'https://example.com/watch/9527', pageTitle: '示例影片 · 在线观看',
      meta: { duration: 154.2, width: 1920, height: 1080 },
      foundAt: now - 52000, lastAt: now - 40000
    },
    {
      id: 'sn_demo_2', url: 'https://cdn.example.com/movie/feature.webm',
      normUrl: 'https://cdn.example.com/movie/feature.webm',
      kind: 'video', container: 'WebM', ext: 'webm', mime: 'video/webm',
      size: 132 * 1024 * 1024, confidence: 0.95, basis: 'mime', reason: '响应类型 video/webm',
      downloadable: true, isSegment: false, hits: 1, tabId: 1,
      pageUrl: 'https://example.com/watch/9527', pageTitle: '示例影片 · 在线观看',
      meta: null, foundAt: now - 48000, lastAt: now - 48000
    },
    {
      id: 'sn_demo_3', url: 'https://cdn.example.com/live/master.m3u8?token=abc123',
      normUrl: 'https://cdn.example.com/live/master.m3u8?token=abc123',
      kind: 'stream', container: 'HLS', ext: 'm3u8', mime: 'application/vnd.apple.mpegurl',
      size: 2410, confidence: 0.95, basis: 'mime', reason: '响应类型 application/vnd.apple.mpegurl',
      downloadable: false, isSegment: false, hits: 1, tabId: 1,
      pageUrl: 'https://example.com/watch/9527', pageTitle: '示例影片 · 在线观看',
      meta: null, foundAt: now - 44000, lastAt: now - 44000
    },
    {
      id: 'sn_demo_4', url: 'https://api.example.com/v1/media/8123',
      normUrl: 'https://api.example.com/v1/media/8123',
      kind: 'video', container: 'MP4', ext: '', mime: 'video/mp4',
      size: 7.4 * 1024 * 1024, confidence: 0.95, basis: 'mime',
      reason: '响应类型 video/mp4（地址里没有扩展名，靠响应类型救回）',
      downloadable: true, isSegment: false, hits: 1, tabId: 1,
      pageUrl: 'https://example.com/watch/9527', pageTitle: '示例影片 · 在线观看',
      meta: { duration: 62.5, width: 1280, height: 720 },
      foundAt: now - 36000, lastAt: now - 36000
    },
    {
      id: 'sn_demo_5', url: 'https://cdn.example.com/audio/podcast-ep42.mp3',
      normUrl: 'https://cdn.example.com/audio/podcast-ep42.mp3',
      kind: 'audio', container: 'MP3', ext: 'mp3', mime: 'audio/mpeg',
      size: 61 * 1024 * 1024, confidence: 0.95, basis: 'mime', reason: '响应类型 audio/mpeg',
      downloadable: true, isSegment: false, hits: 1, tabId: 1,
      pageUrl: 'https://example.com/watch/9527', pageTitle: '示例影片 · 在线观看',
      meta: { duration: 3745, width: 0, height: 0 },
      foundAt: now - 30000, lastAt: now - 30000
    },
    {
      id: 'sn_demo_6', url: 'https://files.example.com/legacy/setup-installer.mkv',
      normUrl: 'https://files.example.com/legacy/setup-installer.mkv',
      kind: 'video', container: 'MKV', ext: 'mkv', mime: 'application/octet-stream',
      size: 22 * 1024 * 1024, confidence: 0.7, basis: 'octet-stream+ext',
      reason: '通用二进制类型 + 扩展名 .mkv',
      downloadable: true, isSegment: false, hits: 1, tabId: 1,
      pageUrl: 'https://example.com/watch/9527', pageTitle: '示例影片 · 在线观看',
      meta: null, foundAt: now - 24000, lastAt: now - 24000
    },
    {
      id: 'sn_demo_7', url: 'https://cdn.example.com/movie/subtitles/chs.vtt',
      normUrl: 'https://cdn.example.com/movie/subtitles/chs.vtt',
      kind: 'subtitle', container: 'VTT', ext: 'vtt', mime: 'text/vtt',
      size: 42 * 1024, confidence: 0.95, basis: 'mime', reason: '响应类型 text/vtt',
      downloadable: true, isSegment: false, hits: 1, tabId: 1,
      pageUrl: 'https://example.com/watch/9527', pageTitle: '示例影片 · 在线观看',
      meta: null, foundAt: now - 18000, lastAt: now - 18000
    },
    ...[0, 1, 2, 3].map((i) => ({
      id: 'sn_seg_' + i, url: `https://cdn.example.com/live/seg-${1000 + i}.ts`,
      normUrl: `https://cdn.example.com/live/seg-${1000 + i}.ts`,
      kind: 'video', container: 'TS', ext: 'ts', mime: 'video/mp2t',
      size: 480 * 1024 + i * 2048, confidence: 0.95, basis: 'mime', reason: '响应类型 video/mp2t',
      downloadable: true, isSegment: true, hits: 1, tabId: 1,
      pageUrl: 'https://example.com/watch/9527', pageTitle: '示例影片 · 在线观看',
      meta: null, foundAt: now - 12000 + i * 1000, lastAt: now - 12000 + i * 1000
    }))
  ];

  const mockSniffStats = (tabId) => {
    const list = tabId == null ? sniffDemo : sniffDemo.filter((r) => r.tabId === tabId);
    const byKind = { video: 0, audio: 0, stream: 0, subtitle: 0 };
    let bytes = 0;
    let segments = 0;
    for (const r of list) {
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      if (r.isSegment) segments += 1;
      if (r.size > 0) bytes += r.size;
    }
    return { total: list.length, byKind, segments, bytes, seen: 23, filtered: 41, enabled: true };
  };

  /* 下载任务样例：形状与主进程引擎的 snapshot() 完全一致，
     分片进度特意做成参差不齐，好让分段进度条看起来就是「多条连接在跑」。 */
  const mkChunks = (total, n, ratios) => {
    const size = Math.floor(total / n);
    return Array.from({ length: n }, (_, i) => {
      const start = i * size;
      const end = i === n - 1 ? total - 1 : start + size - 1;
      const s = end - start + 1;
      const r = ratios[i % ratios.length];
      const done = Math.floor(s * r);
      return { index: i, start, end, size: s, done, state: r >= 1 ? 'done' : 'active', progress: r };
    });
  };

  const dlBig = 8 * 1024 * 1024;
  const dlMid = 3 * 1024 * 1024;

  const downloads = [
    {
      id: 'dl_demo_1',
      url: 'https://mirrors.example.com/ubuntu/noble-desktop-amd64.iso',
      finalUrl: 'https://mirrors.example.com/ubuntu/noble-desktop-amd64.iso',
      filename: 'noble-desktop-amd64.iso',
      savePath: 'C:\\Users\\you\\Downloads\\noble-desktop-amd64.iso',
      dir: 'C:\\Users\\you\\Downloads',
      source: 'page',
      state: 'downloading',
      error: null,
      total: dlBig,
      received: Math.floor(dlBig * 0.62),
      progress: 0.62,
      speed: 9.4 * 1024 * 1024,
      eta: 4,
      threads: 8,
      requestedThreads: 8,
      ranged: true,
      connections: 8,
      mime: 'application/x-iso9660-image',
      createdAt: now - 120000,
      startedAt: now - 118000,
      endedAt: 0,
      chunks: mkChunks(dlBig, 8, [1, 1, 0.83, 0.71, 0.66, 0.58, 0.42, 0.31])
    },
    {
      id: 'dl_demo_2',
      url: 'https://legacy.example.com/driver/setup.exe',
      finalUrl: 'https://legacy.example.com/driver/setup.exe',
      filename: 'setup.exe',
      savePath: 'C:\\Users\\you\\Downloads\\setup.exe',
      dir: 'C:\\Users\\you\\Downloads',
      source: 'page',
      state: 'downloading',
      error: null,
      total: dlMid,
      received: Math.floor(dlMid * 0.35),
      progress: 0.35,
      speed: 640 * 1024,
      eta: 3,
      threads: 1,
      requestedThreads: 8,
      ranged: false,
      connections: 1,
      mime: 'application/octet-stream',
      createdAt: now - 60000,
      startedAt: now - 58000,
      endedAt: 0,
      chunks: [{ index: 0, start: 0, end: null, size: dlMid, done: Math.floor(dlMid * 0.35), state: 'active', progress: 0.35 }]
    },
    {
      id: 'dl_demo_3',
      url: 'https://cdn.example.com/assets/theme-pack.zip',
      finalUrl: 'https://cdn.example.com/assets/theme-pack.zip',
      filename: 'theme-pack.zip',
      savePath: 'C:\\Users\\you\\Downloads\\theme-pack.zip',
      dir: 'C:\\Users\\you\\Downloads',
      source: 'manual',
      state: 'done',
      error: null,
      total: 24 * 1024 * 1024,
      received: 24 * 1024 * 1024,
      progress: 1,
      speed: 0,
      eta: -1,
      threads: 8,
      requestedThreads: 8,
      ranged: true,
      connections: 8,
      mime: 'application/zip',
      createdAt: now - 900000,
      startedAt: now - 899000,
      endedAt: now - 895000,
      chunks: mkChunks(24 * 1024 * 1024, 8, [1])
    },
    {
      id: 'dl_demo_4',
      url: 'http://old-mirror.example.org/pub/archive.tar.gz',
      finalUrl: 'http://old-mirror.example.org/pub/archive.tar.gz',
      filename: 'archive.tar.gz',
      savePath: '',
      dir: 'C:\\Users\\you\\Downloads',
      source: 'page',
      state: 'error',
      error: 'HTTP 403（已重试 3 次）· 已交回 Chromium 内建下载器',
      total: -1,
      received: 0,
      progress: 0,
      speed: 0,
      eta: -1,
      threads: 1,
      requestedThreads: 8,
      ranged: false,
      connections: 1,
      mime: '',
      createdAt: now - 1800000,
      startedAt: now - 1799000,
      endedAt: now - 1798000,
      chunks: []
    }
  ];

  const state = {
    settings: {
      homepage: 'https://52ta.top/',
      newTabPage: 'start',
      ntpShortcuts: { added: [], removed: [] },
      searchTemplate: 'https://www.baidu.com/s?wd=%s',
      defaultEngine: 'chromium',
      layout: 'auto',
      bookmarkBar: 'always',
      theme: 'light',
      restoreSession: true,
      session: { tabs: [], activeIndex: 0 },
      download: { takeOver: true, threads: 8, maxConcurrent: 3, dir: '' },
      sniffer: { enabled: true, minSizeKB: 0, showSegments: false, autoProbe: true },
      mobile: { noImage: 'image', autoPage: true, autoPageMax: 10 },
      adblock: {
        enabled: true, cosmetic: true, level: 'standard', allowlist: [], userLists: [],
        sources: { adtchrome: true, abp: true, builtin: true }
      },
      extensions: [],
      // 与真实配置的初值对齐：新标签页宫格里的那六个内置入口，装好就能点。
      // 预览里照抄同一份，截图与真机才是同一个画面。
      bookmarks: [
        { title: '主页', url: 'https://www.52ta.top/' },
        { title: '导航', url: 'https://52ta.top/' },
        { title: '播放器', url: 'https://music.52ta.top/' },
        { title: '浏览器', url: 'https://nova.52ta.top/' },
        { title: '百度', url: 'https://www.baidu.com/' },
        { title: 'DeepSeek', url: 'https://chat.deepseek.com/' }
      ],
      history: []
    },
    downloads,
    /** 下载目录（预览里是假的，界面上会注明） */
    downloadsDir: 'C:\\Users\\you\\Downloads',
    extensions: [
      {
        id: 'ublock-origin-lite', name: 'uBlock Origin Lite', version: '1.52.2',
        description: '高效宽频内容过滤器，拦截广告与追踪脚本。',
        manifestVersion: 3, source: 'chromium-store', packageVersion: 'CRX v3',
        changes: [], enabled: true, icon: null
      },
      {
        id: 'dark-reader', name: 'Dark Reader', version: '4.9.86',
        description: '为每个网站生成暗色主题，护眼且可调。',
        manifestVersion: 3, source: 'chromium-store', packageVersion: 'CRX v3',
        changes: [], enabled: true, icon: null
      },
      {
        id: 'tampermonkey', name: 'Tampermonkey', version: '5.1.1',
        description: '用户脚本管理器，配合 Gecko 内核使用。',
        manifestVersion: 2, source: 'firefox', packageVersion: null,
        changes: [
          '移除 Firefox 专有字段 browser_specific_settings',
          '过滤 2 项 Gecko 专有权限',
          '注入 browser.* → chrome.* 兼容桥'
        ],
        enabled: true, icon: null
      }
    ],
    adblock: {
      blocked: 138,
      enabled: true,
      cosmetic: true,
      level: 'standard',
      rules: {
        network: 133904, cosmetic: 37569, exceptions: 3474, generic: 14,
        indexedDomains: 116851, indexedTokens: 5566, universal: 1267, universalCssBytes: 233000
      },
      // 与真实引擎 statsSnapshot() 同构 —— 预览里看到的数字就是实机装载三个源后的实测值
      sources: [
        {
          id: 'adtchrome', name: '广告终结者', vendor: 'ChinaList + EasyList 修正',
          kind: 'remote', enabled: true, loaded: true, blocked: 41,
          counts: { network: 11761, cosmetic: 6906, exceptions: 898, skipped: 118 },
          note: '国内站点覆盖为主。官方订阅域 sub.adtchrome.com 已停服，使用同血统的 ChinaList 维护版还原。',
          lists: [
            { title: 'ChinaList · EasyList 修正版', rules: 16843, url: 'https://cdn.jsdelivr.net/gh/Zsy-2014/ChinaList2.0@master/ChinaList2.0.txt' },
            { title: "CJX's Annoyance List", rules: 1824, url: 'https://cdn.jsdelivr.net/gh/cjx82630/cjxlist@master/cjx-annoyance.txt' }
          ]
        },
        {
          id: 'abp', name: 'Adblock Plus', vendor: 'EasyList 官方规则',
          kind: 'remote', enabled: true, loaded: true, blocked: 84,
          counts: { network: 121936, cosmetic: 30574, exceptions: 2576, skipped: 649 },
          note: 'EasyList 是 Adblock Plus 的默认主订阅，面向国际站点。',
          lists: [
            { title: 'EasyList', rules: 79654, url: 'https://filters.adtidy.org/extension/chromium/filters/101.txt' },
            { title: 'EasyList China', rules: 17447, url: 'https://filters.adtidy.org/extension/chromium/filters/104.txt' },
            { title: 'EasyPrivacy', rules: 55409, url: 'https://filters.adtidy.org/extension/chromium/filters/118.txt' }
          ]
        },
        {
          id: 'builtin', name: '系统内置拦截器', vendor: '吾爱Nova 自带清单',
          kind: 'builtin', enabled: true, loaded: true, blocked: 13,
          counts: { network: 207, cosmetic: 89, exceptions: 0, skipped: 0 },
          note: '随安装包分发，不依赖网络，首次启动即有基础防护。',
          lists: [{ title: '吾爱Nova 内置清单', rules: 296, url: '' }]
        }
      ],
      top: [
        { host: 'hm.baidu.com', count: 34 },
        { host: 'googlesyndication.com', count: 27 },
        { host: 'cpro.baidu.com', count: 21 },
        { host: 'doubleclick.net', count: 18 },
        { host: 'cnzz.com', count: 14 },
        { host: 'gdt.qq.com', count: 11 }
      ],
      topRules: [
        { rule: '||hm.baidu.com^$third-party', count: 34 },
        { rule: '||pagead2.googlesyndication.com^', count: 27 }
      ]
    },
    history: [
      { title: '52ta.top · 首页', url: 'https://52ta.top/', ts: now - 60000, visits: 3 },
      { title: '百度一下，你就知道', url: 'https://www.baidu.com/', ts: now - 3600000, visits: 1 },
      { title: '某个只在 IE 下能打开的老系统', url: 'http://legacy.example.com/login.aspx', ts: now - 7200000, visits: 1 },
      { title: 'Firefox 扩展文档 - MDN', url: 'https://developer.mozilla.org/zh-CN/docs/Mozilla/Add-ons', ts: now - 86400000, visits: 2 }
    ],
    appVersion: '1.0.3（预览）',
    versions: { electron: '30.x（预览）', chrome: '126.0.6478.0（预览）', node: '20.x（预览）' },
    platform: 'win32',
    allowlist: []
  };

  const emit = (channel, payload) => {
    const set = listeners.get(channel);
    if (set) set.forEach((fn) => fn(payload));
  };

  /** 预览模式下的「有新版」假数据。字段与真实 updater.check() 的返回一致，
 *  这样预览里看到的排版就是真实情况下的排版。 */
const MOCK_UPDATE = {
    version: '1.0.1',
    url: 'https://example.test/nova-pc-1.0.1-win-x64-setup.zip',
    sha256: 'preview',
    size: 4 * 1024 * 1024,
    notes: [
      '修了一处：下载浮窗在窗口较窄时被右侧边缘裁掉',
      '修了一处：AI 侧边窗口尚未载入完成时不再误报「初始化失败」',
      '新标签页的六个固定入口不再随访问记录增减'
    ]
  };

  const mockStats = () => {
    const list = state.downloads;
    return {
      active: list.filter((t) => ['probing', 'downloading', 'progress'].includes(t.state)).length,
      done: list.filter((t) => ['done', 'completed'].includes(t.state)).length,
      error: list.filter((t) => t.state === 'error').length,
      queued: list.filter((t) => t.state === 'queued').length,
      speed: list.reduce((a, t) => a + (t.speed || 0), 0),
      total: list.length
    };
  };

  const setDl = (id, next) => {
    const t = state.downloads.find((x) => x.id === id);
    if (!t) return false;
    t.state = next;
    t.speed = next === 'downloading' ? 1.2 * 1024 * 1024 : 0;
    setTimeout(() => emit('download:update', t), 0);
    return true;
  };

  window.nova = {
    platform: 'win32',
    isPreview: true,

    bootstrap: async () => ({
      settings: state.settings,
      defaults: DEFAULTS,
      newTabFileUrl: NEWTAB_FILE_URL,
      engines,
      extensions: state.extensions,
      adblock: state.adblock,
      downloads: state.downloads,
      downloadStats: mockStats(),
      downloadsDir: state.downloadsDir,
      sniffStats: mockSniffStats(),
      sniffFormats: SNIFF_FORMATS,
      nomedia: {
        level: state.settings.mobile.noImage,
        label: state.settings.mobile.noImage === 'off' ? '关闭'
          : (state.settings.mobile.noImage === 'image' ? '无图' : '无图 + 视频'),
        types: state.settings.mobile.noImage === 'off' ? []
          : (state.settings.mobile.noImage === 'image' ? ['image'] : ['image', 'media']),
        blocked: 128,
        byType: { image: 121, media: 7 },
        tabBlocked: 34,
        pageAllowed: false
      },
      /** 占位样式的真身在主进程 nomedia.js 里，预览模式给一份同形的短版即可 */
      noImageCss: 'html.nova-no-image img{background-color:rgba(128,132,140,.16)!important;}',
      noImageJs: "document.documentElement.classList.add('nova-no-image');",
      platform: state.platform,
      appVersion: state.appVersion,
      versions: state.versions,
      allowlist: state.allowlist
    }),

    settings: {
      patch: async (partial) => {
        const merge = (base, patch) => {
          const out = Object.assign({}, base);
          for (const [k, v] of Object.entries(patch || {})) {
            out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
          }
          return out;
        };
        state.settings = merge(state.settings, partial);
        setTimeout(() => emit('settings:changed', state.settings), 0);
        return state.settings;
      }
    },

    engines: {
      list: async () => engines,
      reResolve: async () => {
        engines[1].fallbackReason = '未找到原生宿主 native/bin/gecko-host.exe，已降级为兼容层';
        return engines;
      }
    },

    adblock: {
      stats: async () => state.adblock,
      reset: async () => {
        state.adblock = Object.assign({}, state.adblock, {
          blocked: 0, top: [],
          sources: state.adblock.sources.map((s) => Object.assign({}, s, { blocked: 0 }))
        });
        return state.adblock;
      },
      sourceToggle: async (id, enabled) => {
        state.adblock = Object.assign({}, state.adblock, {
          sources: state.adblock.sources.map((s) => (s.id === id ? Object.assign({}, s, { enabled: !!enabled }) : s))
        });
        state.settings.adblock.sources[id] = !!enabled;
        return state.adblock;
      },
      allowlistAdd: async (host) => {
        if (!state.allowlist.includes(host)) state.allowlist.push(host);
        return state.allowlist;
      },
      allowlistRemove: async (host) => {
        state.allowlist = state.allowlist.filter((h) => h !== host);
        return state.allowlist;
      },
      importList: async () => ({ imported: 0, note: 'UI 预览模式下不可导入文件' })
    },

    extensions: {
      list: async () => state.extensions,
      install: async () => ({ installed: [], note: 'UI 预览模式下不可安装扩展' }),
      remove: async (id) => {
        state.extensions = state.extensions.filter((e) => e.id !== id);
        setTimeout(() => emit('ext:changed', state.extensions), 0);
        return true;
      },
      // 预览里照抄一份真商店会返回的形状（字段与 ext-store.js 的
      // summarizeDetail 对齐），这样详情卡片和真机上长得一样。
      storeInfo: async (input) => {
        const s = String(input || '');
        if (!/[a-p]{32}/.test(s)) {
          return { error: '认不出扩展。请粘贴商店里那个扩展的页面地址，或者 32 位的扩展 ID。' };
        }
        return {
          crxId: 'iikmkjmpaadaobahmlepeloendndfphd',
          source: 'edge',
          detail: {
            crxId: 'iikmkjmpaadaobahmlepeloendndfphd',
            name: 'Tampermonkey', version: '5.5.1', developer: 'Jan Biniok',
            installs: 13321147, installsText: '1332 万',
            icon: '', description: 'Change the web at will with userscripts',
            manifestVersion: 3
          }
        };
      },
      storeInstall: async () => ({ error: 'UI 预览模式下不可安装扩展' })
    },

    bookmarks: {
      list: async () => state.settings.bookmarks,
      add: async (bm) => {
        if (!state.settings.bookmarks.some((b) => b.url === bm.url)) state.settings.bookmarks.unshift(bm);
        return state.settings.bookmarks;
      },
      remove: async (url) => {
        state.settings.bookmarks = state.settings.bookmarks.filter((b) => b.url !== url);
        return state.settings.bookmarks;
      },
      clear: async () => { state.settings.bookmarks = []; return []; },
      /* 导入导出：预览模式下开不了文件对话框，一律当作「用户取消了」。
         不能假装成功 —— 那样评审点一下看到「导入完成：新增 0 条」，
         会以为真导入成功了。 */
      import: async () => ({ canceled: true }),
      export: async () => ({ canceled: true })
    },

    history: {
      list: async (limit = 200) => state.history.slice(0, limit),
      clear: async () => { state.history = []; return []; }
    },

    /* 内置新标签页的快捷方式。真的那份在主进程里，落的是设置文件的
       ntpShortcuts；这里只演一遍「列表变了」的效果，好让预览里
       点「× 删除」能看出反馈。 */
    ntp: {
      addShortcut: async (label, url) => {
        const cur = state.settings.ntpShortcuts || { added: [], removed: [] };
        const key = NovaNtpHost.hostKey(url);
        state.settings.ntpShortcuts = {
          added: cur.added.filter((a) => NovaNtpHost.hostKey(a.url) !== key)
            .concat([{ label: label || key, url }]),
          removed: cur.removed.filter((k) => k !== key)
        };
        return state.settings.ntpShortcuts;
      },
      removeShortcut: async (url) => {
        const cur = state.settings.ntpShortcuts || { added: [], removed: [] };
        const key = NovaNtpHost.hostKey(url);
        state.settings.ntpShortcuts = {
          added: cur.added.filter((a) => NovaNtpHost.hostKey(a.url) !== key),
          removed: cur.removed.includes(key) ? cur.removed : cur.removed.concat([key])
        };
        return state.settings.ntpShortcuts;
      }
    },

    /* 站点图标表。真的那份在主进程里（src/main/favicon-cache.js）：按主机名
       抓 /favicon.ico，落盘缓存 7 天，再以 data: URI 交出来。

       预览里刻意返回空表 —— 这张表的全部内容都来自真实网络抓取，而预览
       模式是「把外壳当静态页面渲染」，一个请求都不发（shot.js 起的本地
       服务只喂 src/ 下的文件）。返回一张编造的图标表就等于让截图说谎：
       评审看到磁贴上有图标，会以为这个功能本来就通。所以预览里书签格与
       磁贴照旧走它们那层既有的兜底（渐变底 + 首字母），而那一层也是要
       给人看的东西之一。 */
    favicons: {
      json: async () => ({})
    },

    /* 自动更新：预览模式下不联网，但把状态机走全，方便评审交互。
       第一次 check 直接给「有新版」—— 预览环境连不到真实的更新源，
       什么都不给的话评审永远看不到那半边界面长什么样。
       用一个标记记住「已经查过一次」，否则每次渲染层刷新都弹一次。 */
    update: {
      _checked: false,
      check: async function () {
        if (this._checked) return { status: 'available', info: MOCK_UPDATE, error: '' };
        this._checked = true;
        return { status: 'available', info: MOCK_UPDATE, error: '' };
      },
      status: async () => ({ status: 'idle', info: null, error: '' }),
      download: async () => ({ ok: true }),
      install: async () => ({ ok: true })
    },

    /* 下载：预览模式下不真的联网，但把状态机走全，方便评审交互 */
    downloads: {
      list: async () => state.downloads,
      stats: async () => mockStats(),
      create: async ({ url }) => {
        if (!/^https?:\/\//i.test(String(url || ''))) return { error: '只支持 http / https 地址' };
        const id = 'dl_preview_' + Date.now().toString(36);
        const name = decodeURIComponent(String(url).split('/').filter(Boolean).pop() || 'download');
        state.downloads.unshift({
          id, url, finalUrl: url, filename: name, savePath: state.downloadsDir + '\\' + name,
          dir: state.downloadsDir, source: 'manual', state: 'downloading', error: null,
          total: 4 * 1024 * 1024, received: 0, progress: 0, speed: 0, eta: -1,
          threads: state.settings.download.threads, requestedThreads: state.settings.download.threads,
          ranged: true, connections: 0, mime: '', createdAt: Date.now(), startedAt: Date.now(), endedAt: 0,
          chunks: mkChunks(4 * 1024 * 1024, Math.min(8, state.settings.download.threads), [0])
        });
        setTimeout(() => emit('download:update', state.downloads[0]), 0);
        return { id };
      },
      pause: async (id) => setDl(id, 'paused'),
      resume: async (id) => setDl(id, 'downloading'),
      cancel: async (id) => setDl(id, 'canceled'),
      remove: async (id) => { state.downloads = state.downloads.filter((t) => t.id !== id); return true; },
      retry: async (id) => setDl(id, 'downloading'),
      clearFinished: async () => {
        state.downloads = state.downloads.filter((t) => !['done', 'completed', 'canceled', 'error'].includes(t.state));
        return state.downloads;
      },
      open: async () => {},
      showInFolder: async () => {},
      chooseDir: async () => 'C:\\Users\\you\\Downloads',
      dir: async () => state.downloadsDir
    },

    /* 嗅探：预览模式下不真的联网，返回一份覆盖各种判定路径的样例 */
    sniffer: {
      list: async (filter = {}) => {
        const tabId = filter && filter.tabId;
        return sniffDemo.filter((r) => (tabId == null ? true : r.tabId === tabId));
      },
      stats: async (filter = {}) => mockSniffStats(filter && filter.tabId),
      clear: async (filter = {}) => {
        const tabId = filter && filter.tabId;
        if (tabId == null) sniffDemo.length = 0;
        else for (let i = sniffDemo.length - 1; i >= 0; i--) if (sniffDemo[i].tabId === tabId) sniffDemo.splice(i, 1);
        return [];
      },
      resetStats: async () => mockSniffStats(),
      setMeta: async (id, meta) => {
        const rec = sniffDemo.find((r) => r.id === id);
        if (rec) { rec.meta = meta; setTimeout(() => emit('sniff:update', rec), 0); }
        return rec || null;
      },
      formats: async () => SNIFF_FORMATS
    },

    /* --- 移动端阅读（无图模式） --- */
    mobile: {
      state: async () => ({
        noImage: {
          level: state.settings.mobile.noImage,
          label: state.settings.mobile.noImage === 'off' ? '关闭'
            : (state.settings.mobile.noImage === 'image' ? '无图' : '无图 + 视频'),
          types: state.settings.mobile.noImage === 'off' ? []
            : (state.settings.mobile.noImage === 'image' ? ['image'] : ['image', 'media']),
          blocked: 128,
          byType: { image: 121, media: 7 },
          tabBlocked: 34,
          pageAllowed: false
        }
      }),
      stats: async () => ({
        level: state.settings.mobile.noImage,
        label: '无图',
        types: ['image'],
        blocked: 128,
        byType: { image: 121, media: 7 },
        tabBlocked: 34,
        pageAllowed: false
      }),
      showImages: async () => ({
        level: state.settings.mobile.noImage,
        label: '无图',
        types: ['image'],
        blocked: 128,
        byType: { image: 121, media: 7 },
        tabBlocked: 34,
        pageAllowed: true
      }),
      resetStats: async () => ({
        level: state.settings.mobile.noImage,
        label: '无图',
        types: ['image'],
        blocked: 0,
        byType: { image: 0, media: 0 },
        tabBlocked: 0,
        pageAllowed: false
      })
    },

    system: {
      openExternal: async () => {},
      showItemInFolder: async () => {},
      userDataPath: async () => '（UI 预览模式，真实运行时为本机用户目录）',
      openUserData: async () => {},
      clearSiteData: async () => ({ cleared: 0, total: 4, failed: [], note: 'UI 预览模式：不会真的清空站点数据' }),
      copy: async () => true
    },

    window: { minimize() {}, maximize() {}, close() {} },

    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(fn);
      return () => listeners.get(channel).delete(fn);
    },

    /**
     * 手动触发一条事件。真机上没有这个口子 —— 事件都有各自的真实来源
     * （导航、下载、嗅探……），而预览/测试里没人替我们制造它们。
     * 只有 mock 才会挂出这个方法，所以拿它做分支判断是安全的：
     *   if (window.nova.__emit) → 说明跑在预览或 jsdom 测试里。
     */
    __emit: emit,

    log() {}
  };
}
