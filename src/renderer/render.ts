import type { FitMode } from '../shared/types';

export interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * L1 布局适配渲染：把竖屏画面以三种方式铺到桌面窗口上。
 * contain 保持原比例；cover 裁切铺满；ambient 用同屏模糊延展填充满屏。
 */
export class FitRenderer {
  private mode: FitMode = 'ambient';
  private frameSize = { width: 0, height: 0 };
  private rect: DrawRect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly bg: HTMLCanvasElement,
    private readonly fg: HTMLCanvasElement,
  ) {}

  setMode(mode: FitMode): void {
    this.mode = mode;
    this.bg.style.display = mode === 'ambient' ? 'block' : 'none';
  }

  get currentRect(): DrawRect {
    return this.rect;
  }

  get sourceSize(): { width: number; height: number } {
    return this.frameSize;
  }

  private resizeCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(window.innerWidth * dpr);
    const height = Math.round(window.innerHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return canvas.getContext('2d');
  }

  draw(frame: VideoFrame): void {
    this.frameSize = { width: frame.displayWidth, height: frame.displayHeight };
    const dpr = window.devicePixelRatio || 1;
    const viewW = window.innerWidth * dpr;
    const viewH = window.innerHeight * dpr;
    const scaleContain = Math.min(viewW / frame.displayWidth, viewH / frame.displayHeight);
    const scale = this.mode === 'cover' ? Math.max(viewW / frame.displayWidth, viewH / frame.displayHeight) : scaleContain;
    const dw = frame.displayWidth * scale;
    const dh = frame.displayHeight * scale;
    const dx = (viewW - dw) / 2;
    const dy = (viewH - dh) / 2;
    this.rect = { x: dx / dpr, y: dy / dpr, width: dw / dpr, height: dh / dpr };

    if (this.mode === 'ambient') {
      const bgCtx = this.resizeCanvas(this.bg);
      if (bgCtx) {
        bgCtx.filter = 'blur(40px) saturate(1.4) brightness(0.55)';
        bgCtx.drawImage(frame, 0, 0, this.bg.width, this.bg.height);
        bgCtx.filter = 'none';
      }
    }

    const fgCtx = this.resizeCanvas(this.fg);
    if (fgCtx) {
      fgCtx.clearRect(0, 0, this.fg.width, this.fg.height);
      fgCtx.drawImage(frame, dx, dy, dw, dh);
    }
    frame.close();
  }
}
