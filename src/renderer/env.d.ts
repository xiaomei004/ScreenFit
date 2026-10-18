import type { AppStatus, DeviceInfo, FitMode } from '../shared/types';

export interface StartSessionInput {
  serial: string;
  maxSize?: number;
  videoCodec?: 'h264' | 'h265' | 'av1';
  newDisplay?: string;
  flexDisplay?: boolean;
  startApp?: string;
  keepActive?: boolean;
  audio?: boolean;
}

declare global {
  interface Window {
    screenfit: {
      listDevices(): Promise<DeviceInfo[]>;
      startSession(options: StartSessionInput): Promise<void>;
      stopSession(): Promise<void>;
      setFitMode(mode: FitMode): Promise<void>;
      openVideoChannel(): Promise<boolean>;
      onVideoPort(callback: (port: MessagePort) => void): () => void;
      onStatus(callback: (status: AppStatus) => void): () => void;
    };
  }
}
