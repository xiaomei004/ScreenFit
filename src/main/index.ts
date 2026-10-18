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
let videoPort: MessagePortMain | null = null;
let mainWindow: BrowserWindowType | null = null;
let activeSerial = '';

const SERVER_JAR =
  process.env.SCREENFIT_SERVER_JAR ??
  path.join(currentDir, '../../vendor/scrcpy-win64/scrcpy-win64-v5.0.1/scrcpy-server');

function setStatus(status: AppStatus): void {
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
      preload: path.join(currentDir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(currentDir, '../renderer/index.html'));
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
      onExit: () => setStatus({ phase: 'idle' }),
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
  });

  ipcMain.handle(IPC.stopSession, async () => {
    await session?.stop();
    session = null;
    setStatus({ phase: 'idle' });
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  void session?.stop();
  app.quit();
});
