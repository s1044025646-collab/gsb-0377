const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Store } = require('../dist/store.js');
const { StreamService } = require('../dist/service.js');

const MASKED_HI = '8182' + '37fa213d' + '7f93'; // 掩码 "Hi"

function memService() {
  return new StreamService(new Store(':memory:'));
}

test('追加序号幂等：同序号同内容不重复解析，不同内容冲突', () => {
  const svc = memService();
  const st = svc.createStream({ direction: 'c2s' });
  const r1 = svc.append(st.id, 0, 'hex', MASKED_HI);
  assert.equal(r1.events.length, 2);
  const r2 = svc.append(st.id, 0, 'hex', MASKED_HI);
  assert.equal(r2.idempotent, true);
  assert.equal(r2.events.length, 0);
  assert.equal(svc.messages(st.id).length, 1);
  assert.throws(() => svc.append(st.id, 0, 'hex', '8100'), /冲突/);
  assert.throws(() => svc.append(st.id, 5, 'hex', '8100'), /不连续/);
});

test('hex/base64 输入等价，非法编码报错', () => {
  const svc = memService();
  const a = svc.createStream({ direction: 'c2s', id: 'a' });
  const b = svc.createStream({ direction: 'c2s', id: 'b' });
  svc.append(a.id, 0, 'hex', MASKED_HI);
  svc.append(b.id, 0, 'base64', Buffer.from(MASKED_HI, 'hex').toString('base64'));
  assert.deepEqual(svc.messages(a.id), svc.messages(b.id));
  assert.throws(() => svc.append(a.id, 1, 'hex', 'zz'), /hex/);
  assert.throws(() => svc.append(a.id, 1, 'base64', '!!!'), /base64/);
});

test('冻结后拒绝追加，已解析证据保留', () => {
  const svc = memService();
  const st = svc.createStream({ direction: 's2c' });
  svc.append(st.id, 0, 'hex', '8105' + '48656c6c6f'); // Hello
  svc.append(st.id, 1, 'hex', '8001' + '41'); // 非法 continuation
  assert.equal(svc.status(st.id).frozen, true);
  assert.throws(() => svc.append(st.id, 2, 'hex', '8100'), /冻结/);
  assert.equal(svc.frames(st.id).length, 2);
  assert.equal(svc.messages(st.id)[0].text, 'Hello');
  const diag = svc.diagnostics(st.id);
  assert.equal(diag.errors[0].byteOffset, 7);
  assert.equal(diag.errors[0].frameIndex, 1);
});

test('合法 Close 后拒绝追加', () => {
  const svc = memService();
  const st = svc.createStream({ direction: 's2c' });
  svc.append(st.id, 0, 'hex', '8802' + '03e8');
  assert.equal(svc.status(st.id).closed, true);
  assert.throws(() => svc.append(st.id, 1, 'hex', '8100'), /关闭/);
});

test('重启恢复：从半个头部继续提交，状态不串流', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsparse-'));
  try {
    const dbPath = join(dir, 't.db');
    const store1 = new Store(dbPath);
    let svc = new StreamService(store1);
    svc.createStream({ direction: 'c2s', id: 's1' });
    svc.createStream({ direction: 's2c', id: 's2' });
    svc.append('s1', 0, 'hex', MASKED_HI.slice(0, 6)); // 半个头部：81 82 37
    svc.append('s2', 0, 'hex', '8105' + '48656c'); // s2c 半个 Hello
    store1.close();
    const store2 = new Store(dbPath);
    svc = new StreamService(store2); // 模拟重启
    svc.append('s1', 1, 'hex', MASKED_HI.slice(6));
    svc.append('s2', 1, 'hex', '6c6f');
    assert.equal(svc.messages('s1')[0].text, 'Hi');
    assert.equal(svc.messages('s2')[0].text, 'Hello');
    assert.equal(svc.status('s1').direction, 'c2s');
    assert.equal(svc.status('s2').direction, 's2c');
    store2.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows 上 SQLite 句柄释放可能有延迟，临时目录交由系统清理
    }
  }
});

test('finish 幂等且之后拒绝追加', () => {
  const svc = memService();
  const st = svc.createStream({ direction: 's2c' });
  svc.append(st.id, 0, 'hex', '81'); // 半个帧
  const r1 = svc.finish(st.id);
  assert.equal(r1.events[0].code, 'TRUNCATED_FRAME');
  const r2 = svc.finish(st.id);
  assert.equal(r2.events.length, 0);
  assert.throws(() => svc.append(st.id, 1, 'hex', '00'), /结束/);
});

test('不存在的流报 NOT_FOUND', () => {
  const svc = memService();
  assert.throws(() => svc.status('nope'), /不存在/);
});
