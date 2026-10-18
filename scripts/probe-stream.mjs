/**
 * 协议探针：抓 scrcpy-server 视频流的原始字节，校准 header 格式。
 * 用法：node scripts/probe-stream.mjs
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Adb } from '../out/main/adb.js';

const SERIAL = process.env.SF_SERIAL ?? '39d68d32';
const SERVER = 'vendor/scrcpy-win64/scrcpy-win64-v5.0.1/scrcpy-server';
const REMOTE = '/data/local/tmp/scrcpy-server.jar';
const MAX_SIZE = Number(process.env.SF_MAX_SIZE ?? 1280);

// scid 是 32 位有符号 int，必须 <= 0x7fffffff，否则 server 端 parseInt radix16 溢出报错
const scid = Math.floor(Math.random() * 0x7fffffff) >>> 0;
const scidHex = scid.toString(16).padStart(8, '0');
const sockName = `scrcpy_${scidHex}`;

const adb = new Adb('adb');
console.log('push server...');
await adb.push(SERIAL, SERVER, REMOTE);

const server = net.createServer();
const port = await new Promise((res) => {
  server.listen(0, '127.0.0.1', () => res(server.address().port));
});
console.log(`reverse ${sockName} -> tcp:${port}`);
await adb.reverse(SERIAL, `localabstract:${sockName}`, port);

const WITH_AUDIO = process.env.SF_AUDIO === '1';
const args = [
  '-s', SERIAL, 'shell',
  `CLASSPATH=${REMOTE}`,
  'app_process', '/', 'com.genymobile.scrcpy.Server', '5.0.1',
  `scid=${scidHex}`, 'log_level=debug',
  'video=true', 'control=true',
  `audio=${WITH_AUDIO ? 'true' : 'false'}`,
  `max_size=${MAX_SIZE}`,
  ...(process.env.SF_KEEP_ACTIVE === '1' ? ['keep_active=true'] : []),
];
console.log('audio:', WITH_AUDIO);
console.log('spawn server:', args.join(' '));
const child = spawn('adb', args, { windowsHide: true });
child.stdout.on('data', (d) => console.log('[srv]', d.toString().trim()));
child.stderr.on('data', (d) => console.log('[srv:e]', d.toString().trim()));

let collected = Buffer.alloc(0);
let dumped = false;
let connCount = 0;

server.on('connection', (socket) => {
  connCount++;
  const idx = connCount;
  console.log(`=== SOCKET #${idx} CONNECTED at ${Date.now() % 100000}ms ===`);
  socket.setNoDelay(true);
  let first = Buffer.alloc(0);
  let logged = false;
  const logTimer = setTimeout(() => {
    if (!logged) { logged = true; console.log(`  socket#${idx} 3秒内无数据（control?）`); }
  }, 3000);
  socket.on('data', (chunk) => {
    if (!logged) {
      logged = true;
      clearTimeout(logTimer);
      console.log(`  socket#${idx} 首字节(${chunk.length}):`, chunk.subarray(0, 20).toString('hex'));
    }
    if (idx === 1) {
      collected = collected.length ? Buffer.concat([collected, chunk]) : chunk;
      if (!dumped && collected.length >= 220) { dumped = true; dump(); }
    }
    first = first.length ? Buffer.concat([first, chunk]) : chunk;
  });
  socket.on('error', (e) => console.log(`socket#${idx} error:`, e.message));
});

function dump() {
  // 离线解析 packet 边界，校准 header/packet 结构
  console.log('=== 离线解析 packet 边界 ===');
  console.log('name:', JSON.stringify(collected.subarray(0, 64).toString('latin1').replace(/\0+$/, '')));
  console.log('codec:', JSON.stringify(collected.subarray(64, 68).toString('latin1')));
  // 扫描真实 packet 边界：flags 高位为 CONFIG(2) 或 KEYFRAME(1)，且 size 合理
  console.log('=== 扫描候选 packet 起始位置 ===');
  for (let o = 60; o + 12 <= Math.min(4000, collected.length); o++) {
    const pf = collected.readBigUInt64BE(o);
    const hi = Number(pf >> 62n);
    const sz = collected.readUInt32BE(o + 8);
    if ((hi === 1 || hi === 2) && sz > 0 && sz < 500000) {
      console.log(`  off=${o} flags=0x${pf.toString(16)} hi=${hi} size=${sz}`);
    }
  }

  let off = 68;
  for (let i = 0; i < 8 && off + 12 <= collected.length; i++) {
    const ptsFlags = collected.readBigUInt64BE(off);
    const size = collected.readUInt32BE(off + 8);
    const isConfig = (ptsFlags & (1n << 63n)) !== 0n;
    const isKey = (ptsFlags & (1n << 62n)) !== 0n;
    const pts = ptsFlags & ((1n << 62n) - 1n);
    const head = collected.subarray(off + 12, off + 12 + 10).toString('hex');
    console.log(`pkt#${i} @${off} pts=${pts} cfg=${isConfig} key=${isKey} size=${size} data=${head}`);
    if (size > collected.length) { console.log('  !! size 异常，停止'); break; }
    off += 12 + size;
  }
}

setTimeout(async () => {
  console.log('=== total bytes collected:', collected.length, '===');
  if (!dumped) dump();
  try { await adb.reverseRemove(SERIAL, `localabstract:${sockName}`); } catch {}
  try { child.kill(); } catch {}
  process.exit(0);
}, 15000);
