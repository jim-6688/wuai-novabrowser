'use strict';

/**
 * 数一份 PDF 有几页。
 *
 * <p>为什么需要：打印预览要告诉用户「按这套纸张打出来是一页还是两页」——
 * 用户把纸张高度改成 9mm 做小票时，最想确认的就是内容有没有溢到第二页。
 * `printToPDF` 只回一个 Buffer，页数得自己数。
 *
 * <p>怎么数：Skia 出的 PDF 不压缩对象字典，直接数 `/Type /Page` 出现几次即可
 * （`/Type /Pages` 是页树节点，不算 —— 用 `[^s]` 把它排除掉）。
 * 万一以后换了解析器、数不出来，再退回读页树根的 `/Count`（嵌套页树取最大值）。
 *
 * <p>这只是「够用」的实现，不是通用 PDF 解析器：遇到对象流压缩的 PDF 会数成 0，
 * 调用方拿到 0 就当「不知道」处理，别当 0 页显示。
 */
function countPdfPages(buf) {
  if (!buf || !buf.length) return 0;
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);

  const direct = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (direct) return direct;

  let max = 0;
  const re = /\/Count\s+(\d+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

module.exports = { countPdfPages };
