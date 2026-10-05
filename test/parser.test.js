const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Parser } = require('../dist/parser.js');

// 手工构造的已知字节夹具（不经过任何编码器）：
// 掩码文本帧 "Hi"，mask=37fa213d：'H'^0x37=0x7f, 'i'^0xfa=0x93
const MASKED_HI = '8182' + '37fa213d' + '7f93';
// 未掩码文本帧 "Hello"（RFC 6455 示例）
const UNMASKED_HELLO = '8105' + '48656c6c6f';
// 掩码 Ping 空载荷
const MASKED_PING_EMPTY = '8980' + '01020304';
// 掩码 Pong 空载荷
const MASKED_PONG_EMPTY = '8a80' + '01020304';

function feedAll(parser, hex, sizes) {
  const buf = Buffer.from(hex, 'hex');
  const events = [];
  let pos = 0;
  let i = 0;
  while (pos < buf.length) {
    const size = sizes ? sizes[i++ % sizes.length] : buf.length;
    events.push(...parser.feed(buf.subarray(pos, Math.min(pos + size, buf.length))));
    pos += size;
  }
  return events;
}

const kinds = (evs) => evs.map((e) => e.kind);
const errors = (evs) => evs.filter((e) => e.kind === 'error');

test('已知夹具：掩码文本帧 Hi 解掩码结果正确', () => {
  const p = new Parser('c2s');
  const evs = feedAll(p, MASKED_HI);
  assert.deepEqual(kinds(evs), ['frame', 'message']);
  assert.equal(evs[0].payloadHex, '4869'); // 手工核对：解掩码后为 "Hi"
  assert.equal(evs[0].maskKeyHex, '37fa213d');
  assert.equal(evs[1].text, 'Hi');
});

test('已知夹具：s2c 未掩码 Hello', () => {
  const p = new Parser('s2c');
  const evs = feedAll(p, UNMASKED_HELLO);
  assert.equal(evs[0].payloadHex, '48656c6c6f');
  assert.equal(evs[1].text, 'Hello');
});

test('空载荷：文本/Ping/Pong 空载荷', () => {
  const p = new Parser('c2s');
  const evs = feedAll(p, '8180' + '00000000' + MASKED_PING_EMPTY + MASKED_PONG_EMPTY);
  assert.deepEqual(kinds(evs), ['frame', 'message', 'frame', 'frame']);
  assert.equal(evs[1].text, '');
  assert.equal(evs[1].byteLength, 0);
});

test('边界长度：125 基本长度与 126 扩展长度', () => {
  const p = new Parser('s2c');
  const a = Buffer.alloc(125, 0x61);
  const b = Buffer.alloc(126, 0x62);
  const stream = Buffer.concat([
    Buffer.from([0x81, 125]), a,
    Buffer.from([0x81, 126, 0, 126]), b,
  ]);
  const evs = [];
  for (const ch of [stream.subarray(0, 3), stream.subarray(3)]) evs.push(...p.feed(ch));
  const msgs = evs.filter((e) => e.kind === 'message');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].byteLength, 125);
  assert.equal(msgs[1].byteLength, 126);
});

test('边界长度：65535 用 16 位扩展，65536 用 64 位扩展', () => {
  const p = new Parser('s2c');
  const a = Buffer.alloc(65535, 0x61);
  const b = Buffer.alloc(65536, 0x62);
  const h1 = Buffer.from([0x82, 126, 0xff, 0xff]);
  const h2 = Buffer.concat([Buffer.from([0x82, 127]), Buffer.from('0000000000010000', 'hex')]);
  const evs = feedAll(p, Buffer.concat([h1, a, h2, b]).toString('hex'), [4096]);
  const msgs = evs.filter((e) => e.kind === 'message');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].byteLength, 65535);
  assert.equal(msgs[1].byteLength, 65536);
});

test('跨块掩码：掩码键与载荷被任意切块，偏移不重置', () => {
  // mask=11223344，载荷 "abcdef"（6 字节，跨掩码周期边界）
  const payload = Buffer.from('abcdef');
  const key = Buffer.from('11223344', 'hex');
  const masked = Buffer.from(payload.map((v, i) => v ^ key[i % 4]));
  const frame = Buffer.concat([Buffer.from('8186', 'hex'), key, masked]);
  for (const sizes of [[1], [3], [5, 2, 1], [frame.length]]) {
    const p = new Parser('c2s');
    const evs = feedAll(p, frame.toString('hex'), sizes);
    const msg = evs.find((e) => e.kind === 'message');
    assert.equal(msg.text, 'abcdef', `块大小 ${sizes}`);
  }
});

test('UTF-8 跨帧：多字节字符切开，重组后校验通过', () => {
  const full = Buffer.from('你好', 'utf8'); // e4bda0 e5a5bd
  const p = new Parser('s2c');
  const f1 = Buffer.concat([Buffer.from([0x01, 4]), full.subarray(0, 4)]); // 切在"好"中间
  const f2 = Buffer.concat([Buffer.from([0x80, 2]), full.subarray(4)]);
  const evs = feedAll(p, Buffer.concat([f1, f2]).toString('hex'), [3]);
  const msg = evs.find((e) => e.kind === 'message');
  assert.equal(msg.text, '你好');
});

test('非法 UTF-8 文本消息报错并冻结', () => {
  const p = new Parser('s2c');
  const evs = feedAll(p, '8102' + 'fffe');
  assert.equal(errors(evs)[0].code, 'PROTOCOL_ERROR');
  assert.match(errors(evs)[0].message, /UTF-8/);
  assert.equal(p.state.frozen, true);
});

test('非法 continuation：无开放消息', () => {
  const p = new Parser('s2c');
  const evs = feedAll(p, '8001' + '41');
  assert.equal(errors(evs)[0].code, 'PROTOCOL_ERROR');
  assert.match(errors(evs)[0].message, /continuation/);
});

test('分片消息中插入新数据首帧报错', () => {
  const p = new Parser('s2c');
  const evs = feedAll(p, '0101' + '41' + '0101' + '42');
  assert.equal(errors(evs)[0].code, 'PROTOCOL_ERROR');
  assert.match(errors(evs)[0].message, /新的数据首帧/);
});

test('RSV 非零报错', () => {
  const p = new Parser('s2c');
  const evs = feedAll(p, 'c105' + '48656c6c6f'); // RSV1=1
  assert.equal(errors(evs)[0].code, 'PROTOCOL_ERROR');
  assert.match(errors(evs)[0].message, /RSV/);
});

test('c2s 未掩码帧报错；s2c 掩码帧报错', () => {
  const evs1 = feedAll(new Parser('c2s'), UNMASKED_HELLO);
  assert.match(errors(evs1)[0].message, /必须带掩码/);
  const evs2 = feedAll(new Parser('s2c'), MASKED_HI);
  assert.match(errors(evs2)[0].message, /必须不带掩码/);
});

test('不规范长度编码：126 表示小长度、127 表示 <65536', () => {
  const evs1 = feedAll(new Parser('s2c'), '817e' + '0005' + '48656c6c6f');
  assert.match(errors(evs1)[0].message, /不规范长度编码/);
  const evs2 = feedAll(new Parser('s2c'), '817f' + '000000000000ffff');
  assert.match(errors(evs2)[0].message, /不规范长度编码/);
});

test('64 位长度最高位置位非法', () => {
  const evs = feedAll(new Parser('s2c'), '817f' + '8000000000000000');
  assert.match(errors(evs)[0].message, /最高位/);
});

test('控制帧必须 FIN=1 且载荷 <=125', () => {
  const evs1 = feedAll(new Parser('s2c'), '0900'); // 分片 Ping
  assert.match(errors(evs1)[0].message, /最终帧/);
  const big = Buffer.concat([Buffer.from([0x89, 126, 0, 126]), Buffer.alloc(126)]);
  const evs2 = feedAll(new Parser('s2c'), big.toString('hex'));
  assert.match(errors(evs2)[0].message, /125/);
});

test('Ping 可穿插在分片之间，不拼入用户消息', () => {
  const p = new Parser('s2c');
  const hex = '0102' + 'e4bd' + '8900' + '8001' + 'a0'; // 半个"你" + 空Ping + 剩下
  const evs = feedAll(p, hex);
  const frames = evs.filter((e) => e.kind === 'frame');
  assert.equal(frames[1].opcodeName, 'ping');
  const msg = evs.find((e) => e.kind === 'message');
  assert.equal(msg.text, '你');
  assert.equal(msg.frameCount, 2);
});

test('Close：长度 1 拒绝、非法状态码拒绝、原因非法 UTF-8 拒绝', () => {
  const e1 = feedAll(new Parser('s2c'), '8801' + '03');
  assert.match(errors(e1)[0].message, /长度为 1/);
  const e2 = feedAll(new Parser('s2c'), '8802' + '03ed'); // 1005 保留
  assert.match(errors(e2)[0].message, /状态码/);
  const e3 = feedAll(new Parser('s2c'), '8803' + '03e8' + 'ff'); // 1000 + 非法UTF8
  assert.match(errors(e3)[0].message, /UTF-8/);
});

test('合法 Close 关闭流，之后输入被拒绝；未完成分片被记录', () => {
  const p = new Parser('s2c');
  const evs = feedAll(p, '0102' + 'e4bd' + '8802' + '03e8'); // 未结束分片 + Close(1000)
  assert.equal(p.state.closed, true);
  const unfinished = errors(evs).find((e) => e.code === 'UNFINISHED_MESSAGE');
  assert.ok(unfinished);
  const after = p.feed(Buffer.from('8100', 'hex'));
  assert.equal(after[0].code, 'STREAM_CLOSED');
});

test('Close 合法状态码边界：1000/1014/3000/4999 通过，1015/1004/1006/2999 拒绝', () => {
  for (const [code, ok] of [[1000, 1], [1014, 1], [3000, 1], [4999, 1], [1015, 0], [1004, 0], [1006, 0], [2999, 0], [5000, 0]]) {
    const p = new Parser('s2c');
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(code);
    const evs = feedAll(p, Buffer.concat([Buffer.from([0x88, 2]), buf]).toString('hex'));
    const err = errors(evs).find((e) => e.code === 'PROTOCOL_ERROR');
    assert.equal(!err, !!ok, `code=${code}`);
  }
});

test('帧大小与消息大小超限冻结', () => {
  const p1 = new Parser('s2c', { maxFramePayload: 4 });
  const e1 = feedAll(p1, UNMASKED_HELLO);
  assert.equal(errors(e1)[0].code, 'LIMIT_EXCEEDED');
  const p2 = new Parser('s2c', { maxMessageSize: 4 });
  const e2 = feedAll(p2, '0103' + '616161' + '8003' + '626262');
  assert.equal(errors(e2)[0].code, 'LIMIT_EXCEEDED');
  const p3 = new Parser('s2c', { maxTotalBytes: 3 });
  const e3 = feedAll(p3, UNMASKED_HELLO);
  assert.equal(errors(e3)[0].code, 'LIMIT_EXCEEDED');
});

test('结束输入：区分干净边界、半个帧、未结束消息', () => {
  const p1 = new Parser('s2c');
  feedAll(p1, UNMASKED_HELLO);
  assert.equal(p1.finish().length, 0); // 干净

  const p2 = new Parser('s2c');
  feedAll(p2, '81'); // 半个头部
  const e2 = p2.finish();
  assert.equal(e2[0].code, 'TRUNCATED_FRAME');
  assert.equal(e2[0].byteOffset, 0);

  const p3 = new Parser('s2c');
  feedAll(p3, '0102' + 'e4bd'); // 未结束分片
  const e3 = p3.finish();
  assert.equal(e3[0].code, 'UNFINISHED_MESSAGE');
  assert.equal(p3.state.fragment, null);
});

test('错误事件包含流内字节偏移与已确认帧编号', () => {
  const p = new Parser('s2c');
  const evs = feedAll(p, UNMASKED_HELLO + '8001' + '41'); // 1 帧后非法 continuation
  const err = errors(evs)[0];
  assert.equal(err.byteOffset, 7);
  assert.equal(err.frameIndex, 1);
});

test('冻结后不再吞掉后续内容', () => {
  const p = new Parser('s2c');
  feedAll(p, '8001' + '41');
  assert.equal(p.state.frozen, true);
  assert.deepEqual(p.feed(Buffer.from(UNMASKED_HELLO, 'hex')), []);
});
