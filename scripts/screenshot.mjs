/**
 * Spike 辅助工具：截取电脑屏幕，用于验证虚拟显示的布局重排效果。
 * 用法：node scripts/run-electron.mjs scripts/screenshot.mjs <输出路径>
 */
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const { app, desktopCapturer } = electron;

const outPath = process.argv[2] ?? 'spike-screenshot.png';
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1920);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 1080);

const WINDOW_MATCH = process.env.SHOT_WINDOW ?? '';

async function main() {
  const wantWindow = WINDOW_MATCH.length > 0;
  const sources = await desktopCapturer.getSources({
    types: wantWindow ? ['window'] : ['screen'],
    thumbnailSize: { width: WIDTH, height: HEIGHT },
    fetchWindowIcons: false,
  });

  if (sources.length === 0) {
    throw new Error('未捕获到任何源');
  }

  const target = wantWindow
    ? (sources.find((s) => s.name.includes(WINDOW_MATCH)) ?? sources[0])
    : sources[0];
  console.log((wantWindow ? 'window' : 'screen') + ' source:', target.name, `${WIDTH}x${HEIGHT}`);
  if (wantWindow) {
    console.log('all windows:', sources.map((s) => s.name).join(' | '));
  }

  const png = target.thumbnail.toPNG();
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, png);
  console.log('saved:', abs, `${png.length} bytes`);
}

app.whenReady()
  .then(main)
  .catch((err) => {
    console.error('screenshot failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
