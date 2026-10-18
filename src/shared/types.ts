/** 主进程与渲染进程共享的类型与 IPC 通道定义 */

export type FitMode = 'contain' | 'cover' | 'ambient';

export interface DeviceInfo {
  serial: string;
  state: string;
  model: string;
}

export interface VideoMeta {
  codec: 'h264' | 'h265' | 'av1';
  width: number;
  height: number;
  deviceName: string;
}

export type AppStatus =
  | { phase: 'idle' }
  | { phase: 'connecting'; message: string }
  | { phase: 'streaming'; meta?: VideoMeta }
  | { phase: 'error'; message: string };

/** 渲染进程 -> 主进程（反向控制） */
export type ControlMessage =
  | { type: 'touch'; x: number; y: number; action: 'down' | 'move' | 'up' }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; code: number; action: 'down' | 'up' }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'switch-app' };

/** 主进程 -> 渲染进程 */
export type StreamMessage =
  | { type: 'meta'; meta: VideoMeta }
  | { type: 'frame'; data: ArrayBuffer; pts: number; keyframe: boolean; config: boolean };

export const IPC = {
  openVideoChannel: 'video:open-channel',
  videoPort: 'video-port',
  listDevices: 'adb:devices',
  startSession: 'scrcpy:start',
  stopSession: 'scrcpy:stop',
  status: 'status',
  setFitMode: 'view:set-fit',
} as const;

export const PORTS = {
  video: 'screenfit-video-port',
} as const;
