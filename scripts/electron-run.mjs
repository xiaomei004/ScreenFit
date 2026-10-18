/**
 * 启动 Electron。
 * 宿主 IDE 环境可能注入 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node 运行，
 * 这里先清掉再拉起真正的 Electron 可执行文件。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// 部分 Windows 环境下 GPU 进程会因为沙箱崩溃，默认关掉沙箱；可用 SCREENFIT_ELECTRON_ARGS 追加参数
const extraArgs = process.env.SCREENFIT_ELECTRON_ARGS ? process.env.SCREENFIT_ELECTRON_ARGS.split(' ').filter(Boolean) : [];
// 无额外参数时启动应用本体；有参数时把参数当作要运行的脚本（例如 scripts/screenshot.mjs）
const userArgs = process.argv.slice(2);
const args = [...(userArgs.length > 0 ? userArgs : ['.']), '--no-sandbox', '--disable-gpu-sandbox', ...extraArgs];

const child = spawn(electronPath, args, { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
