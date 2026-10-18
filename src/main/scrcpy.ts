import * as net from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Adb } from './adb.js';
import type { VideoMeta } from '../shared/types.js';

export const SERVER_VERSION = '5.0.1';
const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';

const CODEC_BY_ID: Record<number, VideoMeta['codec']> = { 1: 'h264', 2: 'h265', 4: 'av1' };

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
}

export interface VideoPacket {
  data: Buffer;
  pts: number;
  keyframe: boolean;
  config: boolean;
}

export interface ScrcpyHandlers {
  onStatus?(message: string): void;
  onMeta?(meta: VideoMeta): void;
  onVideo?(packet: VideoPacket): void;
  onExit?(code: number | null): void;
}

const FLAG_CONFIG = 1n << 63n;
const FLAG_KEYFRAME = 1n << 62n;
const PTS_MASK = (1n << 62n) - 1n;

/** scrcpy 视频流客户端：部署 server、建立反向隧道、解析视频包 */
export class ScrcpySession {
  private tcpServer?: net.Server;
  private videoSocket?: net.Socket;
  private audioSocket?: net.Socket;
  private controlSocket?: net.Socket;
  private child?: ChildProcessWithoutNullStreams;
  private running = false;
  private pendingData: Buffer = Buffer.alloc(0);
  private dataWaiter?: () => void;
  private streamError?: Error;
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
    const scid = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const socketName = `scrcpy_${scid.toString(16).padStart(8, '0')}`;
    this.serial = options.serial;
    this.socketName = socketName;
    this.pendingData = Buffer.alloc(0);
    this.streamError = undefined;

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
      this.attachVideoData();
    } catch (err) {
      await this.stopInternal();
      throw err;
    }

    if (options.startApp) {
      this.handlers.onStatus?.(`启动应用 ${options.startApp}`);
      await this.adb.shell(options.serial, `monkey -p ${options.startApp} -c android.intent.category.LAUNCHER 1`).catch(() => undefined);
    }

    void this.readVideoLoop();
  }

  async stop(): Promise<void> {
    await this.stopInternal();
  }

  private adbExecutable(options: ScrcpyOptions): string {
    return options.adbPath ?? 'adb';
  }

  private buildServerArgs(scid: number, options: ScrcpyOptions): string[] {
    const params = [`scid=${scid.toString(16).padStart(8, '0')}`, 'log_level=info'];
    if (options.maxSize) params.push(`max_size=${options.maxSize}`);
    if (options.maxFps) params.push(`max_fps=${options.maxFps}`);
    if (options.videoCodec && options.videoCodec !== 'h264') params.push(`video_codec=${options.videoCodec}`);
    if (options.videoBitRate) params.push(`video_bit_rate=${options.videoBitRate}`);
    if (options.audio === false) params.push('audio=false');
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

  private accept(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const server = this.tcpServer;
      if (!server) return reject(new Error('隧道未就绪'));
      const timer = setTimeout(() => reject(new Error('等待设备连接超时（20 秒）')), 20_000);
      server.once('connection', (socket) => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(socket);
      });
    });
  }

  private async awaitConnections(audio: boolean): Promise<void> {
    this.handlers.onStatus?.('等待设备连接视频通道');
    this.videoSocket = await this.accept();
    // 首个连接会先发一个 dummy 字节，用于同步握手
    await this.readExact(this.videoSocket, 1);

    if (audio) {
      this.handlers.onStatus?.('等待设备连接音频通道');
      this.audioSocket = await this.accept();
    }

    this.handlers.onStatus?.('等待设备连接控制通道');
    this.controlSocket = await this.accept();

    const header = await this.readVideoHeader(this.videoSocket);
    this.handlers.onMeta?.(header);
  }

  private async readVideoHeader(socket: net.Socket): Promise<VideoMeta> {
    const nameBuf = await this.readExact(socket, 64);
    const deviceName = nameBuf.toString('utf8').replace(/\0+$/, '').trim();
    const codecBuf = await this.readExact(socket, 1);
    const codecId = codecBuf[0];
    const sizeBuf = await this.readExact(socket, 8);
    const width = sizeBuf.readUInt32BE(0);
    const height = sizeBuf.readUInt32BE(4);
    const codec = CODEC_BY_ID[codecId] ?? 'h264';
    if (!CODEC_BY_ID[codecId]) {
      this.handlers.onStatus?.(`未知编码 id=${codecId}，按 h264 处理`);
    }
    return { codec, width, height, deviceName };
  }

  private async readVideoLoop(): Promise<void> {
    const socket = this.videoSocket;
    if (!socket) return;
    try {
      while (this.running) {
        const header = await this.readExact(socket, 12);
        const ptsFlags = header.readBigUInt64BE(0);
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

  /** 视频 socket 的数据持续累积到 pendingData，readExact 从中切片，避免丢字节 */
  private attachVideoData(): void {
    const socket = this.videoSocket;
    if (!socket) return;
    socket.on('data', (chunk: Buffer) => {
      this.pendingData =
        this.pendingData.length === 0 ? chunk : Buffer.concat([this.pendingData, chunk]);
      if (this.dataWaiter) {
        const waiter = this.dataWaiter;
        this.dataWaiter = undefined;
        waiter();
      }
    });
    socket.on('error', (err: Error) => {
      this.streamError = err;
      this.dataWaiter?.();
      this.dataWaiter = undefined;
    });
    socket.on('close', () => {
      this.streamError = this.streamError ?? new Error('设备连接已关闭');
      this.dataWaiter?.();
      this.dataWaiter = undefined;
    });
  }

  private async readExact(socket: net.Socket, length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    for (;;) {
      if (this.streamError) throw this.streamError;
      if (this.pendingData.length >= length) {
        const out = this.pendingData.subarray(0, length);
        this.pendingData = this.pendingData.subarray(length);
        return out;
      }
      await new Promise<void>((resolve) => {
        this.dataWaiter = resolve;
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
