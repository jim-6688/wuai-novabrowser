'use strict';

/**
 * 本地静态预览服务：把 novabrowser 目录用 HTTP 起起来，
 * 这样 shell.html 的 CSP（'self'）与相对路径脚本都能正常加载，
 * 可以在浏览器里直接点着看整套 UI（走 bridge-mock，标记为「UI 预览」）。
 *
 *   node tools/preview.js          → http://127.0.0.1:4321/src/renderer/shell.html
 *   node tools/preview.js 8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4321);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(req.url.split('?')[0]);
  if (pathname === '/' || pathname === '') pathname = '/src/renderer/shell.html';

  const target = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Nova UI 预览已启动：`);
  console.log(`  外壳（PC/移动端可切）  http://127.0.0.1:${PORT}/src/renderer/shell.html`);
  console.log(`  设计稿                 http://127.0.0.1:${PORT}/design/design-board.html`);
  console.log('按 Ctrl+C 停止。');
});
