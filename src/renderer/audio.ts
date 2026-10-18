import type { AudioMeta } from '../shared/types';

/**
 * 音频流播放器：WebCodecs 解码 + Web Audio 抖动缓冲播放。
 *
 * scrcpy 的音频包是裸 codec 帧（默认 opus，20ms 一包），没有容器也没有时间戳基准，
 * 所以这里自己做缓冲：先攒够 JITTER 时长再开始播，之后按顺序排期，避免网络抖造成断续。
 */
const JITTER_SECONDS = 0.25;
const MAX_BUFFER_SECONDS = 1.5;

export class AudioPlayer {
  private ctx?: AudioContext;
  private gain?: GainNode;
  private decoder?: AudioDecoder;
  private codec?: AudioMeta['codec'];
  private queue: AudioBuffer[] = [];
  private buffered = 0;
  private nextTime = 0;
  private started = false;
  private muted = false;

  constructor(private readonly onError?: (message: string) => void) {}

  setMeta(meta: AudioMeta): void {
    this.codec = meta.codec;
    this.ensureDecoder(meta.codec);
  }

  reset(): void {
    this.queue = [];
    this.buffered = 0;
    this.started = false;
    this.decoder = undefined;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private ensureCodecString(codec: AudioMeta['codec']): string {
    if (codec === 'aac') return 'mp4a.40.2';
    return codec;
  }

  private ensureDecoder(codec: AudioMeta['codec']): void {
    if (this.decoder) return;
    if (typeof AudioDecoder === 'undefined') {
      this.onError?.('当前环境不支持 WebCodecs 音频解码');
      return;
    }
    this.decoder = new AudioDecoder({
      output: (data) => this.enqueue(data),
      error: (err) => this.onError?.(`音频解码失败：${err.message}`),
    });
    try {
      this.decoder.configure({
        codec: this.ensureCodecString(codec),
        sampleRate: 48000,
        numberOfChannels: 2,
      });
    } catch (err) {
      this.onError?.(`音频解码器配置失败：${(err as Error).message}`);
      this.decoder = undefined;
    }
  }

  private ensureContext(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.onError?.('当前环境不支持 Web Audio');
      return undefined;
    }
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    this.ctx = ctx;
    this.gain = gain;
    // 自动播放策略：无用户手势时 AudioContext 处于 suspended，首次交互时恢复
    const resume = () => {
      void ctx.resume();
    };
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
    return ctx;
  }

  feed(packet: { data: ArrayBuffer; pts: number }): void {
    this.ensureContext();
    if (!this.decoder) this.ensureDecoder(this.codec ?? 'opus');
    if (!this.decoder) return;
    try {
      this.decoder.decode(
        new EncodedAudioChunk({ type: 'key', timestamp: packet.pts, data: packet.data }),
      );
    } catch (err) {
      this.onError?.(`音频解码异常：${(err as Error).message}`);
    }
  }

  private enqueue(data: AudioData): void {
    const ctx = this.ensureContext();
    if (!ctx) {
      data.close();
      return;
    }
    const frames = data.numberOfFrames;
    const buffer = ctx.createBuffer(data.numberOfChannels, frames, data.sampleRate);
    for (let channel = 0; channel < data.numberOfChannels; channel++) {
      const plane = new Float32Array(frames);
      data.copyTo(plane, { planeIndex: channel });
      buffer.copyToChannel(plane, channel);
    }
    data.close();

    const duration = buffer.duration;
    this.queue.push(buffer);
    this.buffered += duration;

    if (!this.started) {
      if (this.buffered < JITTER_SECONDS) return;
      this.started = true;
      this.nextTime = ctx.currentTime + 0.05;
    }
    this.drain(ctx);
  }

  private drain(ctx: AudioContext): void {
    // 掉队太多（超过缓冲上限）就丢弃积压，直接追上实时进度
    if (this.nextTime < ctx.currentTime - MAX_BUFFER_SECONDS) {
      const dropCount = Math.max(0, this.queue.length - 2);
      for (let i = 0; i < dropCount; i++) {
        const dropped = this.queue.shift();
        if (dropped) this.buffered -= dropped.duration;
      }
      this.nextTime = ctx.currentTime + 0.05;
    }

    while (this.queue.length > 0) {
      const buffer = this.queue.shift();
      if (!buffer) break;
      this.buffered -= buffer.duration;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const destination = this.gain ?? ctx.destination;
      source.connect(destination);
      const startAt = Math.max(this.nextTime, ctx.currentTime);
      source.start(startAt);
      this.nextTime = startAt + buffer.duration;
    }
  }
}
