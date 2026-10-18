/** 主进程与渲染进程共享的类型与 IPC 通道定义 */

export type FitMode = 'contain' | 'cover' | 'ambient';

export interface DeviceInfo {
  serial: string;
  state: string;
  model: string;
}

export interface VideoMeta {
  codec: 'h264' | 'h265' | 'av1';
  deviceName: string;
  /** v5 视频 header 不含尺寸，尺寸由 SPS/VideoFrame 解析，这里可选 */
  width?: number;
  height?: number;
}

export interface AudioMeta {
  codec: 'opus' | 'aac' | 'flac' | 'raw';
}

export interface StartSessionOptions {
  serial: string;
  maxSize?: number;
  videoCodec?: VideoMeta['codec'];
  newDisplay?: string;
  flexDisplay?: boolean;
  startApp?: string;
  keepActive?: boolean;
  audio?: boolean;
  /** output=整机输出(会静音手机) / playback=抓取播放中的声音(App可拒绝) / mic=麦克风 */
  audioSource?: 'output' | 'playback' | 'mic';
  /** 抓 playback 时让手机同时外放 */
  audioDup?: boolean;
}

export type AppStatus =
  | { phase: 'idle' }
  | { phase: 'connecting'; message: string }
  | { phase: 'streaming'; meta?: VideoMeta; audio?: boolean }
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
  | { type: 'frame'; data: ArrayBuffer; pts: number; keyframe: boolean; config: boolean }
  | { type: 'audio-meta'; meta: AudioMeta }
  | { type: 'audio'; data: ArrayBuffer; pts: number };

export const IPC = {
  openVideoChannel: 'video:open-channel',
  videoPort: 'video-port',
  listDevices: 'adb:devices',
  startSession: 'scrcpy:start',
  stopSession: 'scrcpy:stop',
  status: 'status',
  setFitMode: 'view:set-fit',
  toggleFullscreen: 'view:toggle-fullscreen',
} as const;

export const PORTS = {
  video: 'screenfit-video-port',
} as const;
