import type { AppStatus, DeviceInfo, FitMode, StartSessionOptions } from '../shared/types';

declare global {
  interface Window {
    screenfit: {
      listDevices(): Promise<DeviceInfo[]>;
      startSession(options: StartSessionOptions): Promise<void>;
      stopSession(): Promise<void>;
      setFitMode(mode: FitMode): Promise<void>;
      openVideoChannel(): Promise<boolean>;
      forwardVideoPort(): void;
      toggleFullscreen(): Promise<boolean>;
      onStatus(callback: (status: AppStatus) => void): () => void;
    };
  }
}
