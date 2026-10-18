import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeviceInfo } from '../shared/types.js';

const execFileAsync = promisify(execFile);

export class AdbError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr?: string) {
    super(message);
    this.name = 'AdbError';
  }
}

/** 对 adb 命令行的薄封装。adb 可执行文件路径可配置，默认走 PATH。 */
export class Adb {
  constructor(private readonly executable: string = 'adb') {}

  async run(args: string[], timeout = 30_000): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.executable, args, {
        timeout,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { message?: string; stderr?: string };
      throw new AdbError(`adb ${args.join(' ')} 执行失败: ${e.message ?? '未知错误'}`, args, e.stderr);
    }
  }

  async devices(): Promise<DeviceInfo[]> {
    const out = await this.run(['devices', '-l']);
    const devices: DeviceInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('List of devices')) continue;
      const [serial, state, ...rest] = trimmed.split(/\s+/);
      if (!serial || !state) continue;
      const modelMatch = rest.find((p) => p.startsWith('model:'));
      devices.push({
        serial,
        state,
        model: modelMatch ? modelMatch.slice('model:'.length) : '',
      });
    }
    return devices;
  }

  async push(serial: string, localPath: string, remotePath: string): Promise<void> {
    await this.run(['-s', serial, 'push', localPath, remotePath], 60_000);
  }

  async reverse(serial: string, remote: string, port: number): Promise<void> {
    await this.run(['-s', serial, 'reverse', remote, `tcp:${port}`]);
  }

  async reverseRemove(serial: string, remote: string): Promise<void> {
    await this.run(['-s', serial, 'reverse', '--remove', remote]).catch(() => undefined);
  }

  async shell(serial: string, command: string): Promise<string> {
    return this.run(['-s', serial, 'shell', command]);
  }

  async getprop(serial: string, key: string): Promise<string> {
    const out = await this.shell(serial, `getprop ${key}`);
    return out.trim();
  }

  /** 注入点击/滑动等输入，MVP 阶段用它替代 scrcpy 控制通道（稳定优先） */
  async input(serial: string, args: string): Promise<void> {
    await this.shell(serial, `input ${args}`);
  }

  async tap(serial: string, x: number, y: number): Promise<void> {
    await this.input(serial, `tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(serial: string, x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    await this.input(
      serial,
      `swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${durationMs}`,
    );
  }

  async keyevent(serial: string, code: number): Promise<void> {
    await this.input(serial, `keyevent ${code}`);
  }
}
