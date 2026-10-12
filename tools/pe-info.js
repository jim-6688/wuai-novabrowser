'use strict';

/**
 * 极简 PE / COFF 解析器（纯 Node，无依赖）
 *
 * 用途：验证下载到的「内核程序」是真实、完整、架构正确的可执行映像，
 *       而不是被截断的下载或改名的空文件。
 *
 * 按需读取（fs.readSync 定位读），不把整文件载入内存 —— libcef.dll 有 289MB。
 */

const fs = require('fs');

const MACHINE = {
  0x014c: 'x86 (I386)',
  0x8664: 'x64 (AMD64)',
  0x01c0: 'ARM',
  0xaa64: 'ARM64',
  0x0200: 'IA64',
};

const SUBSYSTEM = {
  1: 'NATIVE (驱动/系统)',
  2: 'WINDOWS_GUI',
  3: 'WINDOWS_CUI (控制台)',
  7: 'POSIX_CUI',
  9: 'WINDOWS_CE_GUI',
  10: 'EFI_APPLICATION',
};

class Reader {
  constructor(file) {
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.hits = 0;
  }
  read(offset, length) {
    if (offset < 0 || offset >= this.size) return Buffer.alloc(0);
    const len = Math.min(length, this.size - offset);
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(this.fd, buf, 0, len, offset);
    this.hits++;
    return n === len ? buf : buf.subarray(0, n);
  }
  u16(o) { const b = this.read(o, 2); return b.length === 2 ? b.readUInt16LE(0) : null; }
  u32(o) { const b = this.read(o, 4); return b.length === 4 ? b.readUInt32LE(0) : null; }
  cstr(o, max = 256) {
    const b = this.read(o, max);
    const z = b.indexOf(0);
    return b.toString('latin1', 0, z >= 0 ? z : b.length);
  }
  close() { try { fs.closeSync(this.fd); } catch {} }
}

function inspect(file, { exportLimit = 40, nameFilter = null, readExports = true } = {}) {
  const out = {
    file: null, valid: false, machine: null, arch: null, is64: null,
    peType: null, subsystem: null, subsystemName: null, sections: 0,
    sizeOfImage: 0, timeStamp: null, linkedAt: null, exportCount: 0,
    exports: [], dllName: null, errors: [],
  };

  let R;
  try { R = new Reader(file); } catch (e) { out.errors.push('无法打开: ' + e.message); return out; }
  try {
    out.fileBytes = R.size;
    if (R.size < 0x40) { out.errors.push('文件过小，不是有效映像'); return out; }
    if (R.u16(0) !== 0x5a4d) { out.errors.push('缺少 MZ 头'); return out; }

    const eLfanew = R.u32(0x3c);
    if (!eLfanew || eLfanew + 24 > R.size) { out.errors.push('e_lfanew 越界'); return out; }
    if (R.u32(eLfanew) !== 0x00004550) { out.errors.push('缺少 PE\\0\\0 签名'); return out; }

    const coff = eLfanew + 4;
    out.machine = R.u16(coff);
    out.arch = MACHINE[out.machine] || '未知(0x' + out.machine.toString(16) + ')';
    const numSections = R.u16(coff + 2);
    const timeStamp = R.u32(coff + 4);
    const sizeOpt = R.u16(coff + 16);
    const optOff = coff + 20;

    if (timeStamp > 0) {
      out.timeStamp = timeStamp;
      out.linkedAt = new Date(timeStamp * 1000).toISOString().slice(0, 10);
    }

    const magic = R.u16(optOff);
    if (magic === 0x10b) { out.peType = 'PE32'; out.is64 = false; }
    else if (magic === 0x20b) { out.peType = 'PE32+'; out.is64 = true; }
    else { out.errors.push('可选头 magic 异常: 0x' + (magic || 0).toString(16)); return out; }

    out.subsystem = R.u16(optOff + 68);
    out.subsystemName = SUBSYSTEM[out.subsystem] || '未知(' + out.subsystem + ')';
    out.sizeOfImage = R.u32(optOff + 56);

    /* 节表 */
    const secOff = optOff + sizeOpt;
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const o = secOff + i * 40;
      if (o + 40 > R.size) break;
      sections.push({
        name: R.read(o, 8).toString('latin1').replace(/\0+$/, ''),
        virtualSize: R.u32(o + 8),
        virtualAddress: R.u32(o + 12),
        rawSize: R.u32(o + 16),
        rawPointer: R.u32(o + 20),
      });
    }
    out.sections = sections.length;
    if (!sections.length) { out.errors.push('节表为空'); return out; }

    const mapRva = (rva) => {
      for (const s of sections) {
        const span = Math.max(s.virtualSize, s.rawSize);
        if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
          return s.rawPointer + (rva - s.virtualAddress);
        }
      }
      return null;
    };

    /* 导出表 */
    const dirOff = optOff + (out.is64 ? 112 : 96);
    const numDirs = R.u32(optOff + (out.is64 ? 108 : 92));
    if (!numDirs || dirOff + 8 > R.size) { out.valid = true; out.partial = '无数据目录'; return out; }

    const expRva = R.u32(dirOff);
    if (!expRva) { out.valid = true; out.partial = '无导出表'; return out; }

    const expOff = mapRva(expRva);
    if (expOff == null) { out.valid = true; out.partial = '导出目录无法映射'; return out; }

    out.dllName = R.cstr(mapRva(R.u32(expOff + 12)) ?? -1);
    const numNames = R.u32(expOff + 24);
    out.exportCount = numNames;

    if (readExports && numNames > 0) {
      const namesOff = mapRva(R.u32(expOff + 32));
      const picked = [];
      if (namesOff != null) {
        // 一次性读完名字 RVA 数组，再逐个取字符串
        const table = R.read(namesOff, Math.min(numNames, 1 << 16) * 4);
        const limit = Math.min(numNames, table.length / 4);
        for (let i = 0; i < limit; i++) {
          const rva = table.readUInt32LE(i * 4);
          const s = R.cstr(mapRva(rva) ?? -1, 192);
          if (!s) continue;
          if (nameFilter && !nameFilter(s)) continue;
          picked.push(s);
          if (picked.length >= exportLimit) break;
        }
      }
      out.exports = picked;
    }

    out.valid = true;
    return out;
  } finally {
    R.close();
  }
}

/* 判断导出符号是否体现某内核特征 */
function detectKernelSignature(info) {
  const ex = info.exports || [];
  const dll = (info.dllName || '').toLowerCase();
  const has = (re) => ex.some((n) => re.test(n));

  if (dll === 'libcef.dll' || has(/^cef_/)) return 'CEF / Chromium Embedded';
  if (dll === 'electron.exe' || has(/^Electron/)) return 'Electron / Chromium';

  /* Trident（IE） */
  if (dll === 'mshtml.dll' || has(/^CreateCoreWebView$|^IESetProtectedMode|^CreateHTMLPropertyPage$|^ClearPhishingFilterData$/)) {
    return 'Trident / MSHTML (IE)';
  }
  if (dll === 'ieframe.dll') return 'Trident / IE 框架';
  if (dll === 'wininet.dll') return 'Trident / IE 网络栈';

  /* Gecko */
  if (dll === 'xul.dll' || has(/^NS_|^XPCOM_|^moz_|_NS_/)) return 'Gecko / XULRunner (XPCOM)';
  if (dll === 'xulrunner.exe' || dll === 'firefox.exe') return 'Gecko / XULRunner 宿主';

  /* Chromium 进程的沙箱特征导出（CEF 示例程序不导出 cef_* 时靠这条） */
  if (has(/^GetHandleVerifier$|^IsSandboxedProcess$|^CrashForException$|^SetLogFatalCrashKey$/)) {
    return 'Chromium 系（沙箱特征导出）';
  }
  if (dll === 'chrome_elf.dll') return 'Chromium 崩溃处理 (chrome_elf)';
  if (dll === 'node.dll') return 'Chromium + Node（Electron 运行库）';

  return null;
}

module.exports = { inspect, detectKernelSignature, MACHINE, SUBSYSTEM };
