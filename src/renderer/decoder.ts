import { annexbToAvcc, avcCodecString, buildAvcC, extractSpsPps, splitAnnexb } from './h264';
import type { VideoMeta } from '../shared/types';

/** 把 scrcpy 的 H.264 流转成 VideoFrame。配置包先到，解码器才能初始化。 */
export class StreamDecoder {
  private decoder: VideoDecoder | null = null;
  private meta: VideoMeta | null = null;

  constructor(
    private readonly onFrame: (frame: VideoFrame) => void,
    private readonly onError: (message: string) => void,
  ) {}

  setMeta(meta: VideoMeta): void {
    this.meta = meta;
  }

  private ensureDecoder(configPacket: Uint8Array): boolean {
    if (this.decoder) return true;
    const spsPps = extractSpsPps(splitAnnexb(configPacket));
    if (!spsPps) {
      this.onError('配置包中没有找到 SPS/PPS，无法初始化解码器');
      return false;
    }
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (error) => this.onError(`解码器错误: ${error.message}`),
    });
    decoder.configure({
      codec: avcCodecString(spsPps.sps),
      description: buildAvcC(spsPps.sps, spsPps.pps),
      // 不传 codedWidth/codedHeight，由 WebCodecs 从 SPS 解析（v5 header 不含尺寸）
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
    });
    this.decoder = decoder;
    return true;
  }

  feed(packet: { data: ArrayBuffer; pts: number; keyframe: boolean; config: boolean }): void {
    const bytes = new Uint8Array(packet.data);
    if (packet.config) {
      if (!this.ensureDecoder(bytes)) return;
      // 纯 config 包（SPS/PPS，非 keyframe）只用于初始化解码器，不参与 decode；
      // WebCodecs 要求 configure 后首个 decode 必须是 key frame
      if (!packet.keyframe) return;
    }
    if (!this.decoder) return;
    const chunk = new EncodedVideoChunk({
      type: packet.keyframe ? 'key' : 'delta',
      timestamp: packet.pts,
      data: annexbToAvcc(bytes),
    });
    this.decoder.decode(chunk);
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }
}
