'use strict';

/**
 * 外部下载协议（ed2k / magnet）的接管。
 * ---------------------------------------------------------------------------
 * Nova 的下载器是纯 HTTP/HTTPS 的（Range 断点续传那套），本身不具备 eD2k 的
 * P2P 能力：`ed2k://|file|名字|大小|哈希|/` 里没有一个能直接 GET 的地址，
 * 真正下载要靠连 eD2k 服务器 / Kad 网络、找源、分块校验。
 *
 * 所以这里做的是浏览器该做的那一层：**识别 → 让用户确认 → 交给系统里注册的客户端**。
 * 关键在「确认」——不能让任意网页静默拉起本地程序。没装客户端时退回「复制链接」，
 * 用户可以自己粘到 eMule / aMule 里。
 *
 * 不自己实现 P2P 是刻意的：Windows 上没有可嵌入的成熟 eD2k 库，
 * 而协议本身（Kad / AICH / LowID）的维护成本远高于收益。
 */

/** 解析 ed2k:// 链接；格式不对返回 null。 */
function parseEd2k(raw) {
  const url = String(raw || '').trim();
  if (!/^ed2k:\/\//i.test(url)) return null;

  // ed2k://|file|name|size|hash|/  → 去掉协议后 split('|') 会得到 ['', 'file', ...]
  const parts = url.replace(/^ed2k:\/\//i, '').split('|');
  const kind = String(parts[1] || '').toLowerCase();

  if (kind === 'file') {
    const name = safeDecode(parts[2] || '');
    const size = Number(parts[3]) || 0;
    const hash = String(parts[4] || '').toLowerCase();
    // 正常的文件链接哈希是 32 位十六进制；不符合就当解析失败，别把垃圾交给客户端
    if (!/^[0-9a-f]{32}$/.test(hash)) return null;
    return { kind: 'file', name, size, hash };
  }

  if (kind === 'server') {
    const host = String(parts[2] || '');
    const port = Number(parts[3]) || 0;
    if (!host || !port) return null;
    return { kind: 'server', host, port };
  }

  return null;
}

/** 解析 magnet:?xt=...&dn=...&xl=...；同样只取展示信息。 */
function parseMagnet(raw) {
  const url = String(raw || '').trim();
  if (!/^magnet:\?/i.test(url)) return null;

  let params;
  try { params = new URLSearchParams(url.slice(url.indexOf('?') + 1)); } catch { return null; }

  const xt = params.get('xt') || '';
  const btih = /urn:btih:([0-9a-z]+)/i.exec(xt);
  return {
    kind: btih ? 'bt' : 'magnet',
    name: safeDecode(params.get('dn') || ''),
    size: Number(params.get('xl')) || 0,
    hash: btih ? btih[1] : xt
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return String(s || ''); }
}

/** 体积展示：只用于对话框，不要求精确到字节。 */
function fmtSize(n) {
  if (!n || n <= 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 只认这两个协议，别的一律不管（交回原来的导航流程）。 */
function isExternalDownloadLink(url) {
  return /^(ed2k|magnet):/i.test(String(url || ''));
}

function buildDetail(url, info) {
  if (!info) {
    return `链接格式无法解析，仍可复制后交给下载客户端：\n${String(url).slice(0, 300)}`;
  }
  if (info.kind === 'server') {
    return `eD2k 服务器：${info.host}:${info.port}\n\n将交给系统里注册的 eD2k 客户端添加。`;
  }
  const name = (info.name || '（未命名）').slice(0, 160);
  const lines = [`文件：${name}`];
  if (info.size) lines.push(`大小：${fmtSize(info.size)}`);
  if (info.hash) lines.push(`哈希：${String(info.hash).slice(0, 80)}`);
  lines.push('', '将交给系统里已注册的 eD2k / 磁力客户端打开。',
    '没装客户端可以选「复制链接」，再到客户端里粘贴。');
  return lines.join('\n');
}

/**
 * 弹确认框并处理 ed2k / magnet 链接。
 *
 * @param {object} o
 * @param {string} o.url             原始链接
 * @param {object} o.dialog          Electron dialog
 * @param {object} o.shell           Electron shell（用 openExternal）
 * @param {object} o.clipboard       Electron clipboard
 * @param {object} [o.parent]        父窗口（可为空）
 * @param {function} [o.toast]       往界面发提示
 * @returns {Promise<boolean>}       是否接管了这次链接
 */
async function handleExternalLink(o) {
  const opts = o || {};
  const url = String(opts.url || '');
  if (!isExternalDownloadLink(url)) return false;

  const isEd2k = /^ed2k:/i.test(url);
  const info = isEd2k ? parseEd2k(url) : parseMagnet(url);

  const box = {
    type: 'question',
    noLink: true,
    title: isEd2k ? 'eD2k 链接' : '磁力链接',
    message: isEd2k ? '这是 eD2k 下载链接' : '这是磁力链接',
    detail: buildDetail(url, info),
    buttons: ['用外部程序打开', '复制链接', '取消'],
    defaultId: 0,
    cancelId: 2
  };

  let response = 2;
  try {
    const parent = opts.parent && typeof opts.parent.isDestroyed === 'function' && !opts.parent.isDestroyed()
      ? opts.parent
      : null;
    const r = parent
      ? await opts.dialog.showMessageBox(parent, box)
      : await opts.dialog.showMessageBox(box);
    response = r && typeof r.response === 'number' ? r.response : 2;
  } catch {
    return true; // 确认框都弹不出来时，宁可不动作
  }

  if (response === 2) return true;

  if (response === 1) {
    opts.clipboard.writeText(url);
    if (opts.toast) opts.toast('链接已复制，可粘贴到下载客户端');
    return true;
  }

  try {
    await opts.shell.openExternal(url);
  } catch {
    // 系统里没有注册这个协议：不静默失败，复制链接并说明
    opts.clipboard.writeText(url);
    if (opts.toast) opts.toast('未检测到可处理该链接的客户端，已复制链接');
  }
  return true;
}

module.exports = {
  parseEd2k, parseMagnet, fmtSize, isExternalDownloadLink, handleExternalLink
};
