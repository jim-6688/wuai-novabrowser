/* ==========================================================================
   打包后处理（electron-builder afterPack）
   --------------------------------------------------------------------------
   electron-builder 把主程序改名成 productName（吾爱Nova浏览器.exe）后，
   常常**漏改**同目录的崩溃上报辅助 dll：Electron 自带的是 electron_wer.dll，
   而 Windows 错误报告（WER）按「<exe 名>_wer.dll」去找，名字对不上就找不到，
   轻则崩溃没 dump，重则某些环境下启动异常。

   这里在打包目录（appOutDir）里把 electron_wer.dll 改名成 <productName>_wer.dll，
   让安装目录里这一对文件名严格匹配。只动这一个文件，不影响别的。
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const outDir = context && context.appOutDir;
  if (!outDir || !fs.existsSync(outDir)) return;

  const productName = (context.packager &&
    context.packager.appInfo &&
    (context.packager.appInfo.productName || context.packager.appInfo.productFilename)) || '吾爱Nova浏览器';

  const oldName = 'electron_wer.dll';
  const newName = productName + '_wer.dll';
  const oldPath = path.join(outDir, oldName);
  const newPath = path.join(outDir, newName);

  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    try {
      fs.renameSync(oldPath, newPath);
      console.log(`[rename-wer] ${oldName} -> ${newName}`);
    } catch (err) {
      console.warn('[rename-wer] 改名失败：', err.message);
    }
  }
};
