import { FitRenderer } from './render';
import { StreamDecoder } from './decoder';
import type { ControlMessage, FitMode, StreamMessage } from '../shared/types';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const bg = el<HTMLCanvasElement>('bg');
const fg = el<HTMLCanvasElement>('fg');
const hud = el<HTMLDivElement>('hud');
const statusEl = el<HTMLDivElement>('status');
const deviceSelect = el<HTMLSelectElement>('device');
const displayInput = el<HTMLInputElement>('display');
const pkgInput = el<HTMLInputElement>('pkg');

const renderer = new FitRenderer(bg, fg);
let port: MessagePort | null = null;

const decoder = new StreamDecoder(
  (frame) => renderer.draw(frame),
  (message) => setStatus(message),
);

function setStatus(text: string): void {
  statusEl.textContent = text;
}

window.screenfit.onStatus((status) => {
  if (status.phase === 'error') setStatus(`错误：${status.message}`);
  else if (status.phase === 'connecting') setStatus(status.message);
  else if (status.phase === 'streaming') {
    const meta = status.meta;
    setStatus(meta ? `投屏中 ${meta.deviceName}（${meta.codec}）` : '投屏中');
  } else setStatus('空闲');
});

async function refreshDevices(): Promise<void> {
  const devices = await window.screenfit.listDevices();
  deviceSelect.innerHTML = '';
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.serial;
    option.textContent = `${device.model || device.serial} · ${device.state}`;
    deviceSelect.appendChild(option);
  }
  if (devices.length === 0) setStatus('没有检测到设备，请插上数据线并开启 USB 调试');
}

// 经 preload 的 window.postMessage 接收视频通道端口（避免 contextBridge 丢原型）
window.addEventListener('message', (event) => {
  const data = event.data as { screenfit?: string } | undefined;
  if (data?.screenfit !== 'video-port') return;
  const videoPort = event.ports[0];
  if (!videoPort) return;
  port = videoPort;
  videoPort.onmessage = (e: MessageEvent<StreamMessage>) => {
    const message = e.data;
    if (message.type === 'meta') decoder.setMeta(message.meta);
    else decoder.feed(message);
  };
  videoPort.start();
});
window.screenfit.forwardVideoPort();
void window.screenfit.openVideoChannel();
void refreshDevices();
setInterval(() => void refreshDevices(), 4000);

// 开发联调：URL 带 #auto 时，检测到设备后自动开始投屏（无需手动点连接）
if (location.hash.includes('auto')) {
  // 用状态机防止 interval 并发重入（listDevices 是异步的，标志必须同步置位）
  let phase: 'wait' | 'busy' | 'done' = 'wait';
  const autoTimer = setInterval(() => {
    if (phase !== 'wait') return;
    phase = 'busy';
    void window.screenfit.listDevices().then((devices) => {
      if (devices.length === 0) {
        phase = 'wait';
        return;
      }
      phase = 'done';
      clearInterval(autoTimer);
      setStatus('自动连接设备…');
      console.log('[ui] auto-connect 触发 startSession');
      void window.screenfit.startSession({ serial: devices[0].serial, maxSize: 1280 });
    });
  }, 1000);
}

el<HTMLButtonElement>('connect').onclick = async () => {
  const serial = deviceSelect.value;
  if (!serial) return setStatus('先选择一台设备');
  console.log('[ui] connect 按钮触发');
  await window.screenfit.startSession({ serial, maxSize: 1920 });
};

el<HTMLButtonElement>('start-app').onclick = async () => {
  const serial = deviceSelect.value;
  if (!serial) return setStatus('先选择一台设备');
  console.log('[ui] start-app 按钮触发');
  await window.screenfit.startSession({
    serial,
    maxSize: 1920,
    newDisplay: displayInput.value.trim() || undefined,
    flexDisplay: true,
    startApp: pkgInput.value.trim() || undefined,
    keepActive: true,
  });
};

el<HTMLButtonElement>('stop').onclick = async () => {
  await window.screenfit.stopSession();
};

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.mode'))) {
  button.onclick = () => {
    const mode = button.dataset.mode as FitMode;
    renderer.setMode(mode);
    for (const other of Array.from(document.querySelectorAll('.mode'))) {
      other.classList.toggle('active', other === button);
    }
    void window.screenfit.setFitMode(mode);
  };
}
document.querySelector<HTMLButtonElement>('.mode[data-mode="ambient"]')?.classList.add('active');

function toDeviceCoordinates(clientX: number, clientY: number): { x: number; y: number } | null {
  const source = renderer.sourceSize;
  const rect = renderer.currentRect;
  if (!source.width || !rect.width) return null;
  return {
    x: ((clientX - rect.x) / rect.width) * source.width,
    y: ((clientY - rect.y) / rect.height) * source.height,
  };
}

function send(message: ControlMessage): void {
  port?.postMessage(message);
}

fg.addEventListener('mousedown', (event) => {
  const point = toDeviceCoordinates(event.clientX, event.clientY);
  if (point) send({ type: 'touch', x: point.x, y: point.y, action: 'down' });
});

fg.addEventListener('mouseup', (event) => {
  const point = toDeviceCoordinates(event.clientX, event.clientY);
  if (point) send({ type: 'touch', x: point.x, y: point.y, action: 'up' });
});

fg.addEventListener('wheel', (event) => {
  const point = toDeviceCoordinates(event.clientX, event.clientY);
  if (point) send({ type: 'scroll', x: point.x, y: point.y, dx: 0, dy: event.deltaY > 0 ? -300 : 300 });
  event.preventDefault();
}, { passive: false });

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') send({ type: 'back' });
  else if (event.key === 'h') send({ type: 'home' });
  else if (event.key === 's') send({ type: 'switch-app' });
});

let hideTimer = 0;
window.addEventListener('mousemove', () => {
  hud.classList.remove('hidden');
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => hud.classList.add('hidden'), 2500);
});
