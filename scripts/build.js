/*
 * 构建脚本：
 *  1. 对全部 JS 源码做语法检查（node --check）；
 *  2. 将 web/ 与核心算法 src/diagnoser.js 装配到 public/；
 *  3. 校验 index.html 引用的本地资源均存在；
 *  4. 生成 build-info.json。
 * 任一步失败即非零退出。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');

function fail(msg) {
  console.error('构建失败：' + msg);
  process.exit(1);
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// 1. 语法检查
const jsDirs = ['src', 'web', 'scripts', 'test'];
const jsFiles = [];
for (const d of jsDirs) {
  const abs = path.join(root, d);
  if (fs.existsSync(abs)) walk(abs, jsFiles);
}
const checked = jsFiles.filter((f) => f.endsWith('.js'));
for (const f of checked) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) fail(`语法检查未通过 ${path.relative(root, f)}\n${r.stderr || r.stdout}`);
}
console.log(`语法检查通过：${checked.length} 个 JS 文件`);

// 2. 装配 public/
fs.rmSync(pub, { recursive: true, force: true });
fs.mkdirSync(pub, { recursive: true });
const webDir = path.join(root, 'web');
const files = [];
for (const entry of fs.readdirSync(webDir)) {
  const src = path.join(webDir, entry);
  if (fs.statSync(src).isFile()) {
    fs.copyFileSync(src, path.join(pub, entry));
    files.push(entry);
  }
}
fs.copyFileSync(path.join(root, 'src', 'diagnoser.js'), path.join(pub, 'diagnoser.js'));
files.push('diagnoser.js');

// 3. 引用校验：index.html 中的本地 src/href 必须存在于 public/
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !/^(https?:|data:|mailto:)/.test(u))
  .map((u) => u.replace(/^\//, ''));
for (const ref of refs) {
  if (!fs.existsSync(path.join(pub, ref))) fail(`index.html 引用的资源不存在：${ref}`);
}
console.log(`引用校验通过：${refs.length} 处本地引用`);

// 4. 构建信息
fs.writeFileSync(
  path.join(pub, 'build-info.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), files: files.sort() }, null, 2) + '\n'
);
console.log(`构建完成：public/ 共 ${files.length} 个资源`);
