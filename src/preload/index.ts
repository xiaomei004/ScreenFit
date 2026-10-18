import electron from 'electron';
import { IPC } from '../shared/types.js';
import type { AppStatus, DeviceInfo, FitMode } from '../shared/types.js';

const { contextBridge, ipcRenderer } = electron;

export interface SessionOptions {
  serial: string;
  maxSize?: number;
  videoCodec?: 'h264' | 'h265' | 'av1';
  newDisplay?: string;
  flexDisplay?: boolean;
  startApp?: string;
  keepActive?: boolean;
  audio?: boolean;
}

const api = {
  listDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke(IPC.listDevices),
  startSession: (options: SessionOptions): Promise<void> => ipcRenderer.invoke(IPC.startSession, options),
  stopSession: (): Promise<void> => ipcRenderer.invoke(IPC.stopSession),
  setFitMode: (mode: FitMode): Promise<void> => ipcRenderer.invoke(IPC.setFitMode, mode),
  openVideoChannel: (): Promise<boolean> => ipcRenderer.invoke(IPC.openVideoChannel),
  // MessagePort 穿过 contextBridge 会丢原型方法，必须经 window.postMessage 转发到主世界
  forwardVideoPort: (): void => {
    ipcRenderer.on(IPC.videoPort, (event: Electron.IpcRendererEvent) => {
      window.postMessage({ screenfit: 'video-port' }, '*', Array.from(event.ports ?? []));
    });
  },
  onStatus: (callback: (status: AppStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: AppStatus) => callback(status);
    ipcRenderer.on(IPC.status, handler as Parameters<typeof ipcRenderer.on>[1]);
    return () => ipcRenderer.removeListener(IPC.status, handler as Parameters<typeof ipcRenderer.on>[1]);
  },
};

contextBridge.exposeInMainWorld('screenfit', api);

export type ScreenfitApi = typeof api;
