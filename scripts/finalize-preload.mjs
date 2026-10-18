/**
 * Electron 的 ESM preload 必须是 .mjs 后缀才会按 ESM 加载。
 * tsc 输出的是 .js，这里在构建收尾时改名为 .mjs。
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = 'out/preload';
const src = path.join(dir, 'index.js');
const dst = path.join(dir, 'index.mjs');

if (fs.existsSync(src)) {
  fs.renameSync(src, dst);
  console.log('[build] preload: index.js -> index.mjs');
} else if (fs.existsSync(dst)) {
  console.log('[build] preload: index.mjs 已存在');
} else {
  console.warn('[build] preload: 未找到 out/preload/index.js');
}
