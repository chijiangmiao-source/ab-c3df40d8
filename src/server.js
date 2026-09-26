/*
 * 静态服务器：托管构建产物 public/，并提供 /healthz 健康检查。
 * 端口通过环境变量 PORT 调整（默认 8080）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function createServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('请求无法解析');
      return;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('请求路径无法解码');
      return;
    }
    if (pathname === '/') pathname = '/index.html';

    const file = path.normalize(path.join(ROOT, pathname));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('禁止访问');
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('未找到该资源');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(data);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createServer().listen(port, () => {
    console.log(`故障闭环审计页已启动: http://localhost:${port} （健康检查: /healthz）`);
  });
}

module.exports = { createServer };
