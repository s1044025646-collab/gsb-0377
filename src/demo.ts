import { Store } from './store.js';
import { StreamService } from './service.js';

/** 手工构造一个 c2s 掩码帧（仅用于演示拼装字节流）。 */
function maskedFrame(fin: boolean, opcode: number, payload: Buffer, maskKey: Buffer): Buffer {
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i % 4];
  const header: number[] = [(fin ? 0x80 : 0) | opcode];
  if (payload.length < 126) {
    header.push(0x80 | payload.length);
  } else if (payload.length < 65536) {
    header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    header.push(0x80 | 127);
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    header.push(...len);
  }
  return Buffer.concat([Buffer.from(header), maskKey, masked]);
}

const text = '你好，WebSocket 分片！';
const full = Buffer.from(text, 'utf8');
const cut = 7; // 故意切在一个多字节字符中间，验证 UTF-8 跨帧重组
const mask1 = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
const mask2 = Buffer.from([0x11, 0x22, 0x33, 0x44]);
const maskPing = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

const stream = Buffer.concat([
  maskedFrame(false, 0x1, full.subarray(0, cut), mask1),
  maskedFrame(true, 0x9, Buffer.from('hi'), maskPing),
  maskedFrame(true, 0x0, full.subarray(cut), mask2),
]);

console.log(`演示字节流（hex，共 ${stream.length} 字节）：`);
console.log(stream.toString('hex'));
console.log();

const chunkings: number[][] = [
  [stream.length],
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  [2, 3, 5, 7, 11, 13],
  [stream.length - 1, 1],
];

const store = new Store(':memory:');
const service = new StreamService(store);
let baseline: string | null = null;

for (let round = 0; round < chunkings.length; round++) {
  const st = service.createStream({ direction: 'c2s', id: `demo-${round}` });
  let pos = 0;
  let seq = 0;
  for (const size of chunkings[round]) {
    if (pos >= stream.length) break;
    const chunk = stream.subarray(pos, Math.min(pos + size, stream.length));
    service.append(st.id, seq++, 'hex', chunk.toString('hex'));
    pos += size;
  }
  if (pos < stream.length) service.append(st.id, seq++, 'hex', stream.subarray(pos).toString('hex'));
  service.finish(st.id);
  const frames = service.frames(st.id) as any[];
  const messages = service.messages(st.id) as any[];
  const signature = JSON.stringify({ frames, messages });
  console.log(`--- 分块方案 ${round}（块大小 ${chunkings[round].join(',')}）---`);
  for (const f of frames) {
    console.log(
      `帧#${f.frameIndex} @字节${f.offset} ${f.opcodeName} FIN=${f.fin ? 1 : 0} 载荷=${f.payloadLength} mask=${f.maskKeyHex} 解掩码=${f.payloadHex}`
    );
  }
  for (const m of messages) {
    console.log(`消息#${m.messageIndex} ${m.type} 帧数=${m.frameCount} 文本=${JSON.stringify(m.text)}`);
  }
  if (baseline === null) baseline = signature;
  console.log(`与基准结果一致：${signature === baseline ? '是' : '否'}`);
  console.log();
}
store.close();
