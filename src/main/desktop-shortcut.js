'use strict';

/**
 * 桌面快捷方式（Windows · 免安装形态）
 * ---------------------------------------------------------------------------
 * 走安装包进来的用户不需要这份代码：NSIS 安装器按 `createDesktopShortcut`
 * 就把图标放到桌面了，卸载时也由它收走 —— 那条路应用自己不用操心。
 *
 * 免安装的绿色版没有安装器。用户把压缩包解到「下载」文件夹里，双击 exe 就用上了，
 * 桌面干干净净；下次想再开一次，还得回到那个文件夹里翻。这份代码补的就是这一步：
 * 打包后第一次跑起来时，桌上没有就放一个。
 *
 * 几处刻意的取舍：
 *
 *   1) 只做一次（settings.desktopShortcut 打标），不是每次启动都补。
 *      用户把图标删了，下次开浏览器它又长回来 —— 那个删除动作就是假的。
 *      与 settings.js 里 bookmarkSeed（内置书签只补种一次）是同一条口径。
 *
 *   2) 桌面已经有同名图标，就原样留着，一个字节都不改。
 *      桌面上那个可能是安装器建的、可能是用户自己右键建了又改过名字的、
 *      也可能已经被钉在任务栏上。再写一遍只会把他的设置冲掉。「已经有」也算
 *      这件事办完了 —— 同样打标，省得每次启动都来查一遍。
 *
 *   3) 只在「确认桌面已有」之后才落盘标记。
 *      建失败（桌面只读、组策略限制、磁盘满）不打标，下次启动还会再试一次。
 *      反过来，先打标再建，一次偶发失败就等于永远不建了。
 *
 *   4) 名字与安装版写死成同一个词（「吾爱Nova浏览器」）。
 *      同一台机器上先后用过安装版和绿色版的人，桌面上不该出现两个名字不一样的
 *      图标；而且只有同名才算「已经有」，第 2 条才拦得住。
 *
 *   5) 只在打包后动手（app.isPackaged）。
 *      开发时 `npm start` 跑的是 node_modules 里的 electron.exe，给它建桌面图标
 *      毫无意义，而且会在开发机上留下一堆指向 node_modules 的坏图标。
 *
 * 这里只放纯逻辑与 IO，不 import electron：测试要在没有 Electron 的进程里跑，
 * 并且「写快捷方式」这一步是注入进来的（生产环境注入 shell.writeShortcutLink）。
 * 模块头讲的是取舍，具体接线见 main.js 的 ensureDesktopShortcut()。
 */

const fs = require('fs');
const path = require('path');

/**
 * 快捷方式文件名（不含 .lnk）。
 * 与 package.json 里 NSIS 的 `shortcutName` 是同一个词 —— 见模块头第 4 条，
 * 改一边必须改另一边。
 */
const SHORTCUT_BASENAME = '吾爱Nova浏览器';

/** 桌面上那一个链接的完整文件名。 */
function shortcutFileName(basename) {
  return (basename || SHORTCUT_BASENAME) + '.lnk';
}

/**
 * 该不该动手。三道闸，缺一不可：
 *   win32    —— shell.writeShortcutLink 只在 Windows 上有实现
 *   packaged —— 开发环境跑的不是这个应用自己
 *   !done    —— 已经办过一次了（见模块头第 1、3 条）
 */
function shouldInstall(o) {
  return o.platform === 'win32' && !!o.packaged && !o.done;
}

/**
 * 交给 shell.writeShortcutLink 的选项。
 *
 * icon 指回 exe 自己：打包时 exe 里已经嵌了 nova.ico，不必单独带一份图标文件
 * ——多带一份就多一个「图标文件被用户挪走/删掉，快捷方式变成白纸」的机会。
 *
 * appUserModelId 只在有值时带上。传空串会把「按 target 推断」这条路堵掉，
 * 反而可能让任务栏把同一个应用算成两个，钉一个亮一个。
 */
function linkOptions(o) {
  const exePath = String(o.exePath);
  const opts = {
    target: exePath,
    cwd: path.dirname(exePath),
    description: o.description || SHORTCUT_BASENAME,
    icon: exePath,
    iconIndex: 0
  };
  if (o.appId) opts.appUserModelId = String(o.appId);
  return opts;
}

/**
 * 确保桌面上有那一个图标。
 *
 * @param {object}   o
 * @param {string}   o.desktopDir  桌面目录的绝对路径
 * @param {string}   o.name        快捷方式文件名（含 .lnk）
 * @param {string}   o.exePath     可执行文件绝对路径（生产环境是 process.execPath）
 * @param {string}  [o.description]
 * @param {string}  [o.appId]
 * @param {function} o.writeLink   (lnkPath, options) => boolean，生产环境是
 *                                 shell.writeShortcutLink 绑好的一个参数
 * @returns {'created'|'exists'|'failed'}
 *   created —— 这次真的放上去了
 *   exists  —— 桌上本来就有，没动它
 *   failed  —— 没成；调用方**不要**打标，下次启动再试
 */
function ensureShortcut(o) {
  const lnk = path.join(o.desktopDir, o.name);

  // existsSync 自己不会抛：路径不合法、没权限读，它一律返回 false。
  // 所以这里不必包 try —— 真读不到就往下走，让写这一步去失败。
  if (fs.existsSync(lnk)) return 'exists';

  try {
    // writeShortcutLink 失败时是返回 false，不是抛。两种都要接住：
    // 抛的是参数/平台问题，false 的是「桌面写不进去」。
    return o.writeLink(lnk, linkOptions(o)) ? 'created' : 'failed';
  } catch {
    return 'failed';
  }
}

module.exports = {
  SHORTCUT_BASENAME,
  shortcutFileName,
  shouldInstall,
  linkOptions,
  ensureShortcut
};
