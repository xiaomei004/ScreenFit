import * as net from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Adb } from './adb.js';
import type { AudioMeta, VideoMeta } from '../shared/types.js';

export const SERVER_VERSION = '5.0.1';
const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';

// v5 视频 header：设备名(64) + 编码名(4字节 ASCII: "h264"/"h265"/"av1")，无 width/height
const KNOWN_CODECS = new Set(['h264', 'h265', 'av1']);

export const KEYCODE_BACK = 4;
export const KEYCODE_HOME = 3;
export const KEYCODE_APP_SWITCH = 187;

export interface ScrcpyOptions {
  serial: string;
  serverJar: string;
  adbPath?: string;
  maxSize?: number;
  maxFps?: number;
  videoCodec?: VideoMeta['codec'];
  videoBitRate?: number;
  /** 例如 "1920x1080" 或 "1920x1080/420"；开启后 App 在独立虚拟屏幕中运行 */
  newDisplay?: string;
  /** 让虚拟屏幕随窗口尺寸实时变化，促使 App 重新布局 */
  flexDisplay?: boolean;
  startApp?: string;
  keepActive?: boolean;
  audio?: boolean;
  /** output(默认) / playback / mic —— 对应 server 的 audio_source */
  audioSource?: 'output' | 'playback' | 'mic';
  /** 仅 playback 源下可让手机同时外放 */
  audioDup?: boolean;
}

export interface VideoPacket {
  data: Buffer;
  pts: number;
  keyframe: boolean;
  config: boolean;
}

export interface AudioPacket {
  data: Buffer;
  pts: number;
}

/** audio socket 起始的 4 字节 FourCC："opus"(默认) / "aac\0" / "flac" / "raw\0" */
const AUDIO_CODEC_FOURCC: Record<string, AudioMeta['codec']> = {
  opus: 'opus',
  'aac\0': 'aac',
  flac: 'flac',
  'raw\0': 'raw',
};

export interface ScrcpyHandlers {
  onStatus?(message: string): void;
  onMeta?(meta: VideoMeta): void;
  onVideo?(packet: VideoPacket): void;
  onAudioMeta?(meta: AudioMeta): void;
  onAudio?(packet: AudioPacket): void;
  onExit?(code: number | null): void;
}

// scrcpy v5 packet 位布局（byte0 高3位）：bit63=session标志, bit62=config, bit61=keyframe，低61位=PTS
const FLAG_SESSION = 1n << 63n;
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEYFRAME = 1n << 61n;
const PTS_MASK = (1n << 61n) - 1n;

/** scrcpy 视频流客户端：部署 server、建立反向隧道、解析视频包 */
export class ScrcpySession {
  private tcpServer?: net.Server;
  private videoSocket?: net.Socket;
  private audioSocket?: net.Socket;
  private controlSocket?: net.Socket;
  private child?: ChildProcessWithoutNullStreams;
  private running = false;
  // 视频与音频各有独立缓冲区，共用一个会互相污染导致解析错位
  private buffers: { video: Buffer; audio: Buffer } = { video: Buffer.alloc(0), audio: Buffer.alloc(0) };
  private dataWaiters: { video?: () => void; audio?: () => void } = {};
  private streamError?: Error;
  private pendingSockets: net.Socket[] = [];
  private connectionWaiter?: () => void;
  private serial = '';
  private socketName = '';

  constructor(
    private readonly adb: Adb,
    private readonly handlers: ScrcpyHandlers = {},
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  async start(options: ScrcpyOptions): Promise<void> {
    if (this.running) throw new Error('会话已经在运行');
    // scid 是 32 位有符号 int，必须 <= 0x7fffffff，否则 server 端 parseInt radix16 溢出
    const scid = Math.floor(Math.random() * 0x7fffffff) >>> 0;
    const socketName = `scrcpy_${scid.toString(16).padStart(8, '0')}`;
    this.serial = options.serial;
    this.socketName = socketName;
    this.buffers = { video: Buffer.alloc(0), audio: Buffer.alloc(0) };
    this.dataWaiters = {};
    this.streamError = undefined;
    this.pendingSockets = [];
    this.connectionWaiter = undefined;

    this.handlers.onStatus?.('部署 scrcpy-server 到设备');
    await this.adb.push(options.serial, options.serverJar, DEVICE_SERVER_PATH);

    const port = await this.listen();
    this.handlers.onStatus?.(`建立反向隧道 ${socketName} -> tcp:${port}`);
    await this.adb.reverse(options.serial, `localabstract:${socketName}`, port);

    const args = this.buildServerArgs(scid, options);
    this.handlers.onStatus?.('启动 scrcpy-server');
    this.child = spawn(this.adbExecutable(options), args, { windowsHide: true });
    this.child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.handlers.onStatus?.(`[server] ${text}`);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.handlers.onStatus?.(`[server:err] ${text}`);
    });
    this.child.on('exit', (code) => {
      this.running = false;
      this.handlers.onExit?.(code);
    });

    try {
      await this.awaitConnections(Boolean(options.audio));
      this.running = true;
    } catch (err) {
      await this.stopInternal();
      throw err;
    }

    if (options.startApp) {
      this.handlers.onStatus?.(`启动应用 ${options.startApp}`);
      await this.adb.shell(options.serial, `monkey -p ${options.startApp} -c android.intent.category.LAUNCHER 1`).catch(() => undefined);
    }

    void this.readVideoLoop();
    if (options.audio) void this.readAudioLoop();
  }

  async stop(): Promise<void> {
    await this.stopInternal();
  }

  private adbExecutable(options: ScrcpyOptions): string {
    return options.adbPath ?? 'adb';
  }

  private buildServerArgs(scid: number, options: ScrcpyOptions): string[] {
    const params = [`scid=${scid.toString(16).padStart(8, '0')}`, 'log_level=debug'];
    if (options.maxSize) params.push(`max_size=${options.maxSize}`);
    if (options.maxFps) params.push(`max_fps=${options.maxFps}`);
    if (options.videoCodec && options.videoCodec !== 'h264') params.push(`video_codec=${options.videoCodec}`);
    if (options.videoBitRate) params.push(`video_bit_rate=${options.videoBitRate}`);
    if (options.audio === false) params.push('audio=false');
    else if (options.audio) {
      params.push('audio=true');
      if (options.audioSource && options.audioSource !== 'output') {
        params.push(`audio_source=${options.audioSource}`);
      }
      if (options.audioDup) params.push('audio_dup=true');
    }
    if (options.newDisplay) params.push(`new_display=${options.newDisplay}`);
    if (options.flexDisplay) params.push('flex_display=true');
    if (options.keepActive) params.push('keep_active=true');
    params.push('video=true', 'control=true');

    return [
      '-s',
      options.serial,
      'shell',
      `CLASSPATH=${DEVICE_SERVER_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SERVER_VERSION,
      ...params,
    ];
  }

  private listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      // video 与 control 连接几乎同时到达，必须用常驻监听器把连接入队，
      // 否则 once('connection') 会在两次 accept 的间隙漏掉第二个连接
      server.on('connection', (socket) => {
        socket.setNoDelay(true);
        this.pendingSockets.push(socket);
        this.handlers.onStatus?.(`[tunnel] 连接到达，队列=${this.pendingSockets.length}`);
        const waiter = this.connectionWaiter;
        this.connectionWaiter = undefined;
        waiter?.();
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          this.tcpServer = server;
          resolve(address.port);
        } else {
          reject(new Error('无法获取监听端口'));
        }
      });
    });
  }

  private async accept(label: string): Promise<net.Socket> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const socket = this.pendingSockets.shift();
      if (socket) {
        this.handlers.onStatus?.(`[tunnel] 取出连接 ${label}，剩余=${this.pendingSockets.length}`);
        return socket;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`等待设备连接（${label}）超时`);
      await new Promise<void>((resolve) => {
        this.connectionWaiter = resolve;
        setTimeout(resolve, remaining);
      });
    }
  }

  private async awaitConnections(audio: boolean): Promise<void> {
    this.handlers.onStatus?.('等待设备连接视频通道');
    this.videoSocket = await this.accept('video');
    // v5 reverse 模式下视频 socket 直接发设备名，无 dummy 字节
    // 必须在 readVideoHeader 之前绑定数据事件，否则 readExact 永远等不到数据
    this.attachData(this.videoSocket, 'video');

    if (audio) {
      this.handlers.onStatus?.('等待设备连接音频通道');
      this.audioSocket = await this.accept('audio');
      this.attachData(this.audioSocket, 'audio');
      // audio socket 开头只有 4 字节 codec FourCC（无设备名、无 session packet）
      const codecBuf = await this.readExact(this.audioSocket, 4, 'audio');
      const fourcc = codecBuf.toString('latin1');
      const codec = AUDIO_CODEC_FOURCC[fourcc] ?? 'opus';
      this.handlers.onAudioMeta?.({ codec });
    }

    this.handlers.onStatus?.('等待设备连接控制通道');
    this.controlSocket = await this.accept('control');

    const header = await this.readVideoHeader(this.videoSocket);
    this.handlers.onMeta?.(header);
  }

  private async readVideoHeader(socket: net.Socket): Promise<VideoMeta> {
    const nameBuf = await this.readExact(socket, 64);
    const deviceName = nameBuf.toString('utf8').replace(/\0+$/, '').trim();
    const codecBuf = await this.readExact(socket, 4);
    const codecStr = codecBuf.toString('ascii');
    const codec = (KNOWN_CODECS.has(codecStr) ? codecStr : 'h264') as VideoMeta['codec'];
    if (!KNOWN_CODECS.has(codecStr)) {
      this.handlers.onStatus?.(`未知编码 "${codecStr}"，按 h264 处理`);
    }
    // codec id 之后紧跟一个 session packet（12字节，MSB=1）：byte4-7=width, byte8-11=height
    const sessionPacket = await this.readExact(socket, 12);
    const flags = sessionPacket.readBigUInt64BE(0);
    let width: number | undefined;
    let height: number | undefined;
    if ((flags & FLAG_SESSION) !== 0n) {
      width = sessionPacket.readUInt32BE(4);
      height = sessionPacket.readUInt32BE(8);
    }
    return { codec, deviceName, width, height };
  }

  private async readVideoLoop(): Promise<void> {
    const socket = this.videoSocket;
    if (!socket) return;
    try {
      while (this.running) {
        const header = await this.readExact(socket, 12);
        const ptsFlags = header.readBigUInt64BE(0);
        // session packet（MSB=1）：12字节定长、无 payload，byte4-7=width byte8-11=height，仅更新尺寸
        if ((ptsFlags & FLAG_SESSION) !== 0n) {
          const w = header.readUInt32BE(4);
          const h = header.readUInt32BE(8);
          this.handlers.onStatus?.(`[session] 尺寸变更 ${w}x${h}`);
          continue;
        }
        const size = header.readUInt32BE(8);
        const payload = await this.readExact(socket, size);
        this.handlers.onVideo?.({
          data: payload,
          pts: Number(ptsFlags & PTS_MASK),
          keyframe: (ptsFlags & FLAG_KEYFRAME) !== 0n,
          config: (ptsFlags & FLAG_CONFIG) !== 0n,
        });
      }
    } catch (err) {
      if (this.running) {
        this.handlers.onStatus?.(`视频流中断: ${(err as Error).message}`);
        this.running = false;
      }
    }
  }

  /** 音频流：与视频相同的 12 字节 media packet 头，但无 session packet */
  private async readAudioLoop(): Promise<void> {
    const socket = this.audioSocket;
    if (!socket) return;
    try {
      while (this.running) {
        const header = await this.readExact(socket, 12, 'audio');
        const ptsFlags = header.readBigUInt64BE(0);
        const size = header.readUInt32BE(8);
        const payload = await this.readExact(socket, size, 'audio');
        this.handlers.onAudio?.({ data: payload, pts: Number(ptsFlags & PTS_MASK) });
      }
    } catch (err) {
      if (this.running) {
        this.handlers.onStatus?.(`音频流中断: ${(err as Error).message}`);
      }
    }
  }

  /** socket 数据持续累积到对应缓冲区，readExact 从中切片，避免丢字节 */
  private attachData(socket: net.Socket, kind: 'video' | 'audio'): void {
    socket.once('data', (chunk: Buffer) => {
      this.handlers.onStatus?.(`[${kind}] 首字节 x${chunk.length}: ${chunk.subarray(0, 16).toString('hex')}`);
    });
    socket.on('data', (chunk: Buffer) => {
      const current = this.buffers[kind];
      this.buffers[kind] =
        current.length === 0 ? chunk : Buffer.concat([current, chunk]);
      const waiter = this.dataWaiters[kind];
      this.dataWaiters[kind] = undefined;
      waiter?.();
    });
    socket.on('error', (err: Error) => {
      this.streamError = err;
      this.wakeWaiters();
    });
    socket.on('close', () => {
      this.streamError = this.streamError ?? new Error('设备连接已关闭');
      this.wakeWaiters();
    });
  }

  private wakeWaiters(): void {
    this.dataWaiters.video?.();
    this.dataWaiters.audio?.();
    this.dataWaiters = {};
  }

  private async readExact(
    _socket: net.Socket,
    length: number,
    kind: 'video' | 'audio' = 'video',
  ): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    for (;;) {
      if (this.streamError) throw this.streamError;
      const buffer = this.buffers[kind];
      if (buffer.length >= length) {
        const out = buffer.subarray(0, length);
        this.buffers[kind] = buffer.subarray(length);
        return out;
      }
      await new Promise<void>((resolve) => {
        this.dataWaiters[kind] = resolve;
      });
      if (this.streamError) throw this.streamError;
    }
  }

  private async stopInternal(): Promise<void> {
    this.running = false;
    for (const socket of [this.videoSocket, this.audioSocket, this.controlSocket]) {
      socket?.destroy();
    }
    this.videoSocket = undefined;
    this.audioSocket = undefined;
    this.controlSocket = undefined;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = undefined;
    this.tcpServer?.close();
    this.tcpServer = undefined;
    if (this.serial && this.socketName) {
      await this.adb.reverseRemove(this.serial, `localabstract:${this.socketName}`);
    }
  }
}
