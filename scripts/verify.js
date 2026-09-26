/*
 * verify：Compose 中的核对服务。
 * 依次执行：
 *   [1/3] 代码测试（静默双环、可诊断回执等用例，node --test）
 *   [2/3] 构建检查（语法检查 + public/ 装配 + 引用校验）
 *   [3/3] 页面 HTTP 冒烟（默认打 app 服务；无 SMOKE_BASE_URL 时拉起本地实例）
 * 全部通过则退出码 0，任一失败则退出码 1。
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let failures = 0;

function step(title) {
  console.log('\n=== ' + title + ' ===');
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  return r.status === 0;
}

async function smoke() {
  const base = process.env.SMOKE_BASE_URL;
  let server = null;
  let url = base;
  if (!url) {
    const { createServer } = require(path.join(root, 'src', 'server.js'));
    server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    url = 'http://127.0.0.1:' + server.address().port;
    console.log('未提供 SMOKE_BASE_URL，已拉起本地实例：' + url);
  } else {
    console.log('冒烟目标：' + url);
  }

  const checks = [
    ['GET /', '/', 200, (b) => b.includes('故障闭环审计') && b.includes('app.js')],
    ['GET /healthz', '/healthz', 200, (b) => { try { return JSON.parse(b).status === 'ok'; } catch { return false; } }],
    ['GET /diagnoser.js', '/diagnoser.js', 200, (b) => b.includes('diagnose')],
    ['GET /app.js', '/app.js', 200, null],
    ['GET /worker.js', '/worker.js', 200, null],
    ['GET /styles.css', '/styles.css', 200, null],
    ['GET /no-such-page', '/no-such-page', 404, null]
  ];

  let ok = true;
  for (const [name, p, expect, fn] of checks) {
    try {
      const res = await fetch(url + p);
      const body = await res.text();
      const pass = res.status === expect && (!fn || fn(body));
      console.log((pass ? '✓ ' : '✗ ') + name + ' → ' + res.status + (pass ? '' : '（预期 ' + expect + '）'));
      if (!pass) ok = false;
    } catch (e) {
      console.log('✗ ' + name + ' → 请求失败：' + e.message);
      ok = false;
    }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  return ok;
}

(async () => {
  step('[1/3] 代码测试：静默双环 / 可诊断回执 等');
  if (!run(process.execPath, ['--test', path.join(root, 'test')])) {
    failures++;
    console.error('代码测试未通过。');
  }

  step('[2/3] 构建检查');
  if (!run(process.execPath, [path.join(root, 'scripts', 'build.js')])) {
    failures++;
    console.error('构建检查未通过。');
  }

  step('[3/3] 页面 HTTP 冒烟');
  try {
    if (!(await smoke())) {
      failures++;
      console.error('页面 HTTP 冒烟未通过。');
    }
  } catch (e) {
    failures++;
    console.error('页面 HTTP 冒烟异常：' + ((e && e.stack) || e));
  }

  console.log('\n=== 核对结果 ===');
  if (failures) {
    console.log('失败：' + failures + ' 个环节未通过。');
    process.exit(1);
  }
  console.log('全部通过：代码测试、构建检查、页面 HTTP 冒烟。');
  process.exit(0);
})();
