/** H.264 Annex B 与 AVCC 之间的转换工具，用于喂给 WebCodecs */

export interface SpsPps {
  sps: Uint8Array;
  pps: Uint8Array;
}

/** 按起始码切分 NAL 单元（支持 3 字节与 4 字节起始码） */
export function splitAnnexb(data: Uint8Array): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        const end = i > 0 && data[i - 1] === 0 ? i - 1 : i;
        nalus.push(data.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < data.length) {
    nalus.push(data.subarray(start));
  }
  return nalus;
}

export function extractSpsPps(nalus: Uint8Array[]): SpsPps | null {
  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  for (const nalu of nalus) {
    const type = nalu[0] & 0x1f;
    if (type === 7 && !sps) sps = nalu;
    else if (type === 8 && !pps) pps = nalu;
  }
  return sps && pps ? { sps, pps } : null;
}

/** 组装 AVCDecoderConfigurationRecord */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out[0] = 1;
  out[1] = sps[1];
  out[2] = sps[2];
  out[3] = sps[3];
  out[4] = 0xff;
  out[5] = 0xe1;
  out[6] = (sps.length >> 8) & 0xff;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  const offset = 8 + sps.length;
  out[offset] = 1;
  out[offset + 1] = (pps.length >> 8) & 0xff;
  out[offset + 2] = pps.length & 0xff;
  out.set(pps, offset + 3);
  return out;
}

export function avcCodecString(sps: Uint8Array): string {
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/** Annex B（起始码）转 AVCC（4 字节长度前缀），WebCodecs 需要后者 */
export function annexbToAvcc(data: Uint8Array): Uint8Array {
  const nalus = splitAnnexb(data);
  let total = 0;
  for (const nalu of nalus) total += 4 + nalu.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nalu of nalus) {
    out[offset] = (nalu.length >>> 24) & 0xff;
    out[offset + 1] = (nalu.length >>> 16) & 0xff;
    out[offset + 2] = (nalu.length >>> 8) & 0xff;
    out[offset + 3] = nalu.length & 0xff;
    out.set(nalu, offset + 4);
    offset += 4 + nalu.length;
  }
  return out;
}
