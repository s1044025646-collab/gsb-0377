// 演示：掩码文本消息分两帧、中间穿插 Ping，用不同大小的输入块重复喂入，结果应一致。
import { Parser } from './parser';

// ---- 手工构造的已知字节夹具（不经过任何编码器） ----
// 文本 "Hello" 分两片: "Hel" / "lo"，掩码键 0x11223344 / 0xa0b0c0d0
// 'H'^0x11=0x59 'e'^0x22=0x47 'l'^0x33=0x5f
const frame1 = '018311223344' + '59475f';                  // text fin=0 掩码 "Hel"
const ping  = '898455667788' + '250919ef';                 // ping 掩码 "pong" 掩码键 0x55667788
const frame2 = '8082a0b0c0d0' + 'ccdf';                    // continuation fin=1 掩码 "lo"
const STREAM = frame1 + ping + frame2;

function runOnce(chunkSizes: number[]) {
  const p = new Parser('c2s');
  const all = [];
  let i = 0, n = 0;
  while (i < STREAM.length) {
    const size = chunkSizes[n % chunkSizes.length] * 2; // 字节 -> hex 字符
    const evs = p.feed(Buffer.from(STREAM.slice(i, i + size), 'hex'));
    all.push(...evs);
    i += size; n++;
  }
  all.push(...p.finish());
  return all;
}

const plans: number[][] = [
  [STREAM.length / 2],          // 一次喂入
  [1],                          // 逐字节
  [3, 1, 4, 1, 5, 2],           // 不规则小块
  [6, 2, 7],
];

const results = plans.map(runOnce);
const base = JSON.stringify(results[0]);
let ok = true;
results.forEach((r, i) => {
  const same = JSON.stringify(r) === base;
  if (!same) ok = false;
  console.log(`分块方案 ${i + 1} [${plans[i]}]: ${same ? '一致' : '不一致!'}`);
});

console.log('--- 事件 ---');
for (const ev of results[0]) console.log(JSON.stringify(ev));

const msg = results[0].find((e: any) => e.type === 'message') as any;
console.log(`\n重组消息文本: ${JSON.stringify(msg?.text)}`);
if (!ok || msg?.text !== 'Hello') {
  console.error('演示失败');
  process.exit(1);
}
console.log('演示通过：不同分块喂入结果一致，消息 = "Hello"');

