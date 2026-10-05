import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store, ApiError } from '../src/store';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-'));
  return new Store(path.join(dir, 't.db'));
}

const MASKED_HI = Buffer.from('818201020304496b', 'hex'); // 掩码 "Hi"

test('新建流、追加、查询帧与消息', () => {
  const s = tmpStore();
  const st = s.createStream('c2s');
  const evs = s.append(st.id, 0, MASKED_HI);
  assert.equal(evs.filter((e) => e.type === 'message').length, 1);
  assert.equal(s.frames(st.id).length, 1);
  assert.equal((s.messages(st.id)[0] as any).text, 'Hi');
  s.close();
});

test('相同序号同内容幂等，内容不同报冲突，跳号报缺口', () => {
  const s = tmpStore();
  const st = s.createStream('c2s');
  s.append(st.id, 0, MASKED_HI);
  const again = s.append(st.id, 0, MASKED_HI); // 幂等重放
  assert.deepEqual(again, []);
  assert.throws(() => s.append(st.id, 0, Buffer.from('00', 'hex')),
    (e: any) => e instanceof ApiError && e.code === 'SEQ_CONFLICT');
  assert.throws(() => s.append(st.id, 5, MASKED_HI),
    (e: any) => e instanceof ApiError && e.code === 'SEQ_GAP');
  s.close();
});

test('半个头部持久化，重启后（新 Store 实例）可继续提交', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-'));
  const db = path.join(dir, 't.db');
  let s = new Store(db);
  const st = s.createStream('c2s');
  s.append(st.id, 0, Buffer.from('8182', 'hex')); // 只有头部，无掩码键无载荷
  assert.equal(s.frames(st.id).length, 0);
  s.close();

  s = new Store(db); // 模拟重启
  const evs = s.append(st.id, 1, Buffer.from('01020304496b', 'hex'));
  assert.equal((evs.find((e) => e.type === 'message') as any).text, 'Hi');
  s.close();
});

test('不同流的缓冲与分片状态互不影响', () => {
  const s = tmpStore();
  const a = s.createStream('c2s');
  const b = s.createStream('s2c');
  s.append(a.id, 0, Buffer.from('8182', 'hex'));   // a 流挂起半帧
  const evsB = s.append(b.id, 0, Buffer.from('81024869', 'hex')); // b 流完整未掩码帧
  assert.equal((evsB.find((e) => e.type === 'message') as any).text, 'Hi');
  assert.equal(s.frames(a.id).length, 0);
  s.close();
});

test('错误冻结后状态持久化，诊断保留证据', () => {
  const s = tmpStore();
  const st = s.createStream('s2c');
  s.append(st.id, 0, Buffer.from('81024142', 'hex')); // 合法 "AB"
  s.append(st.id, 1, Buffer.from('c100', 'hex'));     // RSV 错误
  const diag = s.diagnostics(st.id);
  assert.equal(diag.stream.frozen, true);
  assert.equal(diag.counts.messages, 1);
  assert.equal(diag.errors[0].code, 'RSV_NONZERO');
  assert.equal(diag.errors[0].offset, 4);
  assert.equal(diag.errors[0].frameIndex, 1);
  s.close();
});

test('finish 与 eof 事件持久化', () => {
  const s = tmpStore();
  const st = s.createStream('s2c');
  s.append(st.id, 0, Buffer.from('0102e4b8', 'hex')); // 半个 "中"
  const evs = s.finish(st.id);
  assert.equal(evs.some((e) => e.type === 'incomplete-message'), true);
  assert.equal(s.getStream(st.id).finished, true);
  s.close();
});
