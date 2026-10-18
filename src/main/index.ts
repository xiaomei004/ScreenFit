import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import type { BrowserWindow as BrowserWindowType, MessagePortMain } from 'electron';
import { Adb } from './adb.js';
import { KEYCODE_APP_SWITCH, KEYCODE_BACK, KEYCODE_HOME, ScrcpySession } from './scrcpy.js';
import { IPC } from '../shared/types.js';
import type { AppStatus, ControlMessage } from '../shared/types.js';

const { app, BrowserWindow, ipcMain, MessageChannelMain } = electron;

// ESM 下没有 __dirname，用 import.meta.url 推导
const currentDir = path.dirname(fileURLToPath(import.meta.url));

const adb = new Adb();
let session: ScrcpySession | null = null;
let startingSession = false;
let videoPort: MessagePortMain | null = null;
let mainWindow: BrowserWindowType | null = null;
let activeSerial = '';

const SERVER_JAR =
  process.env.SCREENFIT_SERVER_JAR ??
  path.join(currentDir, '../../vendor/scrcpy-win64/scrcpy-win64-v5.0.1/scrcpy-server');

function setStatus(status: AppStatus): void {
  const msg = status.phase === 'connecting' ? status.message : status.phase;
  console.log('[status]', msg);
  mainWindow?.webContents.send(IPC.status, status);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    frame: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // 把渲染进程的 console / preload 错误转发到主进程日志，便于联调
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${path.basename(sourceId)}:${line})`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[preload-error] ${preloadPath}:`, error);
  });

  win.once('ready-to-show', () => win.show());
  const auto = process.env.SCREENFIT_AUTO === '1';
  win.loadFile(path.join(currentDir, '../renderer/index.html'), auto ? { hash: 'auto' } : undefined);
  mainWindow = win;
}

function handleControl(message: ControlMessage): void {
  if (!activeSerial) return;
  switch (message.type) {
    case 'touch':
      if (message.action === 'down') {
        pendingTap = { x: message.x, y: message.y };
      } else if (message.action === 'up' && pendingTap) {
        const dx = message.x - pendingTap.x;
        const dy = message.y - pendingTap.y;
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
          void adb.tap(activeSerial, message.x, message.y);
        } else {
          void adb.swipe(activeSerial, pendingTap.x, pendingTap.y, message.x, message.y);
        }
        pendingTap = null;
      }
      break;
    case 'scroll':
      void adb.swipe(activeSerial, message.x, message.y, message.x, message.y + message.dy, 120);
      break;
    case 'back':
      void adb.keyevent(activeSerial, KEYCODE_BACK);
      break;
    case 'home':
      void adb.keyevent(activeSerial, KEYCODE_HOME);
      break;
    case 'switch-app':
      void adb.keyevent(activeSerial, KEYCODE_APP_SWITCH);
      break;
    case 'key':
      break;
  }
}

let pendingTap: { x: number; y: number } | null = null;

function registerIpc(): void {
  ipcMain.handle(IPC.listDevices, async () => {
    try {
      return await adb.devices();
    } catch (err) {
      setStatus({ phase: 'error', message: (err as Error).message });
      return [];
    }
  });

  ipcMain.handle(IPC.openVideoChannel, async (event) => {
    const { port1, port2 } = new MessageChannelMain();
    port2.on('message', (event2) => {
      handleControl(event2.data as ControlMessage);
    });
    port2.start();
    videoPort = port2;
    event.sender.postMessage(IPC.videoPort, null, [port1]);
    return true;
  });

  ipcMain.handle(IPC.startSession, async (_event, options) => {
    if (startingSession) {
      console.log('[status] 已有会话正在建立，忽略重复请求');
      return;
    }
    startingSession = true;
    console.log('[ipc] startSession', JSON.stringify(options));
    try {
      if (session?.isRunning) await session.stop();
      activeSerial = options.serial;
    session = new ScrcpySession(adb, {
      onStatus: (message) => setStatus({ phase: 'connecting', message }),
      onMeta: (meta) => {
        videoPort?.postMessage({ type: 'meta', meta });
        setStatus({ phase: 'streaming', meta });
      },
      onVideo: (packet) => {
        const copy = new Uint8Array(packet.data);
        videoPort?.postMessage({
          type: 'frame',
          data: copy.buffer,
          pts: packet.pts,
          keyframe: packet.keyframe,
          config: packet.config,
        });
      },
      onExit: (code) => {
        console.log('[ipc] scrcpy-server 退出, code=', code);
        setStatus({ phase: 'idle' });
      },
    });

    try {
      await session.start({
        serial: options.serial,
        serverJar: SERVER_JAR,
        maxSize: options.maxSize ?? 1920,
        videoCodec: options.videoCodec ?? 'h264',
        newDisplay: options.newDisplay,
        flexDisplay: options.flexDisplay ?? false,
        startApp: options.startApp,
        keepActive: options.keepActive ?? true,
        audio: options.audio ?? false,
      });
      } catch (err) {
        setStatus({ phase: 'error', message: (err as Error).message });
        throw err;
      }
    } finally {
      startingSession = false;
    }
  });

  ipcMain.handle(IPC.stopSession, async () => {
    await session?.stop();
    session = null;
    setStatus({ phase: 'idle' });
  });

  // 渲染进程本地已切换渲染模式，这里仅接收以避免未注册报错（后续可按 App 持久化）
  ipcMain.handle(IPC.setFitMode, async () => true);
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  void session?.stop();
  app.quit();
});
