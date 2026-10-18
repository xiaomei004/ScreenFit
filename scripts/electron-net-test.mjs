/**
 * Electron 环境下的网络探针：与 probe-stream.mjs 逻辑完全一致，
 * 用于排查 Electron 主进程与普通 Node 在 socket 行为上的差异。
 * 用法：node scripts/electron-run.mjs scripts/electron-net-test.mjs
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Adb } from '../out/main/adb.js';

const SERIAL = process.env.SF_SERIAL ?? '39d68d32';
const SERVER = 'vendor/scrcpy-win64/scrcpy-win64-v5.0.1/scrcpy-server';
const REMOTE = '/data/local/tmp/scrcpy-server.jar';

const scid = Math.floor(Math.random() * 0x7fffffff) >>> 0;
const scidHex = scid.toString(16).padStart(8, '0');
const sockName = `scrcpy_${scidHex}`;

async function main() {
  const adb = new Adb('adb');
  console.log('push server...');
  await adb.push(SERIAL, SERVER, REMOTE);

  const server = net.createServer();
  const port = await new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res(server.address().port));
  });
  console.log(`reverse ${sockName} -> tcp:${port}`);
  await adb.reverse(SERIAL, `localabstract:${sockName}`, port);

  const args = [
    '-s', SERIAL, 'shell',
    `CLASSPATH=${REMOTE}`,
    'app_process', '/', 'com.genymobile.scrcpy.Server', '5.0.1',
    `scid=${scidHex}`, 'log_level=info',
    'video=true', 'control=true', 'audio=true',
    'max_size=1280', 'keep_active=true',
  ];
  console.log('spawn server');
  const child = spawn('adb', args, { windowsHide: true });
  child.stdout.on('data', (d) => console.log('[srv]', d.toString().trim()));
  child.stderr.on('data', (d) => console.log('[srv:e]', d.toString().trim()));

  let connCount = 0;
  server.on('connection', (socket) => {
    connCount++;
    const idx = connCount;
    console.log(`=== SOCKET #${idx} CONNECTED ===`);
    socket.setNoDelay(true);
    let logged = false;
    const timer = setTimeout(() => {
      if (!logged) console.log(`  socket#${idx} 3秒内无数据（control?）`);
    }, 3000);
    socket.on('data', (chunk) => {
      if (!logged) {
        logged = true;
        clearTimeout(timer);
        console.log(`  socket#${idx} 首字节(${chunk.length}):`, chunk.subarray(0, 20).toString('hex'));
      }
    });
    socket.on('error', (e) => console.log(`socket#${idx} error:`, e.message));
  });

  setTimeout(async () => {
    console.log('=== done ===');
    try { await adb.reverseRemove(SERIAL, `localabstract:${sockName}`); } catch {}
    try { child.kill(); } catch {}
    process.exit(0);
  }, 12000);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
