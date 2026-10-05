import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser, ParserEvent, MessageEvent, FrameEvent } from '../src/parser';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const errors = (evs: ParserEvent[]) => evs.filter((e) => e.type === 'error');
const messages = (evs: ParserEvent[]) => evs.filter((e) => e.type === 'message') as MessageEvent[];
const frames = (evs: ParserEvent[]) => evs.filter((e) => e.type === 'frame') as FrameEvent[];

// 手工夹具：掩码文本 "Hi"，掩码键 01020304
// 'H'=0x48^0x01=0x49, 'i'=0x69^0x02=0x6b
const MASKED_HI = '8182 01020304 496b';

test('手工夹具：解掩码结果与已知明文一致', () => {
  const p = new Parser('c2s');
  const evs = p.feed(hex(MASKED_HI));
  assert.equal(errors(evs).length, 0);
  const msgs = messages(evs);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'Hi');
  assert.equal(msgs[0].payload, '4869'); // "Hi" 的原始字节
  const f = frames(evs)[0];
  assert.equal(f.masked, true);
  assert.equal(f.maskKey, '01020304');
  assert.equal(f.payload, '4869');
});

test('空载荷文本帧', () => {
  const p = new Parser('c2s');
  const evs = p.feed(hex('8180 00000000'));
  assert.equal(errors(evs).length, 0);
  assert.equal(messages(evs)[0].byteLength, 0);
  assert.equal(messages(evs)[0].text, '');
});

test('边界长度 125 / 126(扩展16位) / 65536(扩展64位)', () => {
  // 125: 基本长度
  let p = new Parser('s2c');
  let evs = p.feed(Buffer.concat([hex('82 7d'), Buffer.alloc(125, 0x41)]));
  assert.equal(errors(evs).length, 0);
  assert.equal(frames(evs)[0].payloadLength, 125);

  // 126: 必须用扩展长度
  p = new Parser('s2c');
  evs = p.feed(Buffer.concat([hex('82 7e 007e'), Buffer.alloc(126, 0x42)]));
  assert.equal(errors(evs).length, 0);
  assert.equal(frames(evs)[0].payloadLength, 126);
  assert.equal(frames(evs)[0].headerLength, 4);

  // 65536: 64 位扩展长度
  p = new Parser('s2c');
  evs = p.feed(Buffer.concat([hex('82 7f 0000000000010000'), Buffer.alloc(65536, 0x43)]));
  assert.equal(errors(evs).length, 0);
  assert.equal(frames(evs)[0].payloadLength, 65536);
  assert.equal(frames(evs)[0].headerLength, 10);
});

test('非最小长度编码被拒绝', () => {
  // 用 126 编码长度 5
  let p = new Parser('s2c');
  let evs = p.feed(hex('82 7e 0005 0102030405'));
  assert.equal(errors(evs)[0]?.code, 'NON_MINIMAL_LENGTH');
  // 用 127 编码长度 100
  p = new Parser('s2c');
  evs = p.feed(hex('82 7f 0000000000000064') );
  assert.equal(errors(evs)[0]?.code, 'NON_MINIMAL_LENGTH');
});

test('64 位长度最高位非法', () => {
  const p = new Parser('s2c');
  const evs = p.feed(hex('82 7f 8000000000000000'));
  assert.equal(errors(evs)[0]?.code, 'LENGTH_MSB_SET');
});

test('跨块掩码：掩码键与载荷被任意拆分后结果一致', () => {
  const full = hex(MASKED_HI);
  for (let cut = 0; cut <= full.length; cut++) {
    const p = new Parser('c2s');
    const evs = [...p.feed(full.subarray(0, cut)), ...p.feed(full.subarray(cut))];
    assert.equal(errors(evs).length, 0, `cut=${cut}`);
    assert.equal(messages(evs)[0]?.text, 'Hi', `cut=${cut}`);
  }
});

test('UTF-8 多字节字符跨帧边界', () => {
  // "中" = e4 b8 ad，拆到两帧: [e4 b8] + [ad]
  const p = new Parser('s2c');
  const evs = [
    ...p.feed(hex('01 02 e4b8')),       // text fin=0
    ...p.feed(hex('80 01 ad')),          // continuation fin=1
  ];
  assert.equal(errors(evs).length, 0);
  assert.equal(messages(evs)[0].text, '中');
});

test('非法 UTF-8 文本被拒绝', () => {
  const p = new Parser('s2c');
  const evs = p.feed(hex('81 01 ff'));
  assert.equal(errors(evs)[0]?.code, 'INVALID_UTF8');
});

test('无开放消息时的 continuation 报错', () => {
  const p = new Parser('s2c');
  const evs = p.feed(hex('80 00'));
  const err = errors(evs)[0];
  assert.equal(err?.code, 'UNEXPECTED_CONTINUATION');
  assert.equal(err?.offset, 0);
  assert.equal(err?.frameIndex, 0);
});

test('分片未结束时出现新数据首帧报错，错误含偏移与帧编号', () => {
  const p = new Parser('s2c');
  const evs = [
    ...p.feed(hex('01 01 41')),  // text fin=0 "A"，占 3 字节
    ...p.feed(hex('81 01 42')),  // 新 text 帧
  ];
  const err = errors(evs)[0];
  assert.equal(err?.code, 'MESSAGE_NOT_FINISHED');
  assert.equal(err?.offset, 3);
  assert.equal(err?.frameIndex, 1);
});

test('RSV 非零被拒绝', () => {
  const p = new Parser('s2c');
  const evs = p.feed(hex('c1 00')); // RSV1=1
  assert.equal(errors(evs)[0]?.code, 'RSV_NONZERO');
});

test('客户端帧未掩码被拒绝；服务端帧带掩码被拒绝', () => {
  let p = new Parser('c2s');
  assert.equal(errors(p.feed(hex('81 00')))[0]?.code, 'MASK_REQUIRED');
  p = new Parser('s2c');
  assert.equal(errors(p.feed(hex('81 80 00000000')))[0]?.code, 'MASK_FORBIDDEN');
});

test('控制帧穿插在分片消息之间，不拼进用户消息', () => {
  const p = new Parser('s2c');
  const evs = [
    ...p.feed(hex('01 03 414243')),        // text fin=0 "ABC"
    ...p.feed(hex('89 02 6869')),          // ping "hi"
    ...p.feed(hex('8a 00')),               // pong 空
    ...p.feed(hex('80 03 444546')),        // continuation fin=1 "DEF"
  ];
  assert.equal(errors(evs).length, 0);
  assert.equal(frames(evs).length, 4);
  assert.equal(messages(evs).length, 1);
  assert.equal(messages(evs)[0].text, 'ABCDEF');
  const controls = evs.filter((e) => e.type === 'control');
  assert.equal(controls.length, 2);
});

test('控制帧不得分片且载荷不超过 125', () => {
  let p = new Parser('s2c');
  assert.equal(errors(p.feed(hex('09 00')))[0]?.code, 'CONTROL_FRAGMENTED'); // ping fin=0
  p = new Parser('s2c');
  assert.equal(errors(p.feed(hex('89 7e 007e')))[0]?.code, 'CONTROL_TOO_LARGE');
});

test('Close：长度 1 拒绝、非法状态码拒绝、合法 Close 关闭流', () => {
  let p = new Parser('s2c');
  assert.equal(errors(p.feed(hex('88 01 00')))[0]?.code, 'CLOSE_LEN_ONE');

  p = new Parser('s2c');
  assert.equal(errors(p.feed(hex('88 02 03ee')))[0]?.code, 'BAD_CLOSE_CODE'); // 1006 保留

  p = new Parser('s2c');
  // code=1000 (03e8), reason="bye"
  const evs = p.feed(hex('88 05 03e8 627965'));
  assert.equal(errors(evs).length, 0);
  const close = evs.find((e) => e.type === 'control') as any;
  assert.equal(close.closeCode, 1000);
  assert.equal(close.closeReason, 'bye');
  assert.equal(p.closed, true);
  // 关闭后再输入被拒绝
  const after = p.feed(hex('81 00'));
  assert.equal(errors(after)[0]?.code, 'INPUT_AFTER_CLOSE');
});

test('Close 原因非法 UTF-8 被拒绝', () => {
  const p = new Parser('s2c');
  const evs = p.feed(hex('88 03 03e8 ff'));
  assert.equal(errors(evs)[0]?.code, 'CLOSE_REASON_UTF8');
});

test('超过单帧上限被拒绝', () => {
  const p = new Parser('s2c', { maxStreamBytes: 1e6, maxPayloadBytes: 10, maxMessageBytes: 100 });
  const evs = p.feed(hex('82 0b')); // 11 字节载荷
  assert.equal(errors(evs)[0]?.code, 'PAYLOAD_TOO_LARGE');
});

test('超过消息上限被拒绝', () => {
  const p = new Parser('s2c', { maxStreamBytes: 1e6, maxPayloadBytes: 100, maxMessageBytes: 4 });
  const evs = [
    ...p.feed(hex('02 03 010203')),
    ...p.feed(hex('80 03 040506')),
  ];
  assert.equal(errors(evs)[0]?.code, 'MESSAGE_TOO_LARGE');
});

test('文件尾截断：finish 区分半个帧与未结束消息', () => {
  // 半个帧
  let p = new Parser('s2c');
  p.feed(hex('81 85 0102')); // 声明 5 字节载荷，只来了 2 字节
  let evs = p.finish();
  assert.equal(errors(evs)[0]?.code, 'TRUNCATED_FRAME');

  // 未结束消息
  p = new Parser('s2c');
  p.feed(hex('01 02 4142')); // text fin=0
  evs = p.finish();
  const inc = evs.find((e) => e.type === 'incomplete-message') as any;
  assert.equal(inc.bufferedBytes, 2);
  assert.equal(inc.frameCount, 1);
  assert.equal((evs.find((e) => e.type === 'eof') as any).status, 'open-message');

  // 干净边界
  p = new Parser('s2c');
  p.feed(hex('81 02 4142'));
  evs = p.finish();
  assert.equal((evs.find((e) => e.type === 'eof') as any).status, 'clean');
});

test('错误后冻结，保留已解析证据，拒绝后续内容', () => {
  const p = new Parser('s2c');
  const good = p.feed(hex('81 02 4142')); // 合法 "AB"
  assert.equal(messages(good).length, 1);
  const bad = p.feed(hex('c1 00')); // RSV 错误
  assert.equal(errors(bad)[0]?.code, 'RSV_NONZERO');
  assert.equal(p.frozen, true);
  const after = p.feed(hex('81 00'));
  assert.equal(errors(after)[0]?.code, 'STREAM_FROZEN');
});

test('二进制消息重组', () => {
  const p = new Parser('s2c');
  const evs = [
    ...p.feed(hex('02 02 dead')),
    ...p.feed(hex('80 02 beef')),
  ];
  assert.equal(errors(evs).length, 0);
  assert.equal(messages(evs)[0].payload, 'deadbeef');
  assert.equal(messages(evs)[0].opcodeName, 'binary');
});
