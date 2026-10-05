// CLI：直接操作本地 SQLite，不依赖 HTTP 服务。
// 用法: node dist/src/cli.js <command> [args]
import * as path from 'node:path';
import { Store, ApiError } from './store';
import { Direction, ParserEvent } from './parser';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'ws-parser.db');

function decode(encoding: string, data: string): Buffer {
  if (encoding === 'hex') return Buffer.from(data.replace(/\s+/g, ''), 'hex');
  if (encoding === 'base64') return Buffer.from(data, 'base64');
  throw new ApiError(400, 'BAD_ENCODING', 'encoding 必须是 hex 或 base64');
}

function printEvents(events: ParserEvent[]) {
  for (const ev of events) {
    switch (ev.type) {
      case 'frame':
        console.log(
          `帧#${ev.frameIndex} @${ev.offset} ${ev.opcodeName} fin=${ev.fin ? 1 : 0}` +
          ` len=${ev.payloadLength}${ev.masked ? ` mask=${ev.maskKey}` : ''} payload=${ev.payload}`,
        );
        break;
      case 'message':
        console.log(
          `消息#${ev.messageIndex} [${ev.opcodeName}] ${ev.byteLength}B 帧数=${ev.frameCount}` +
          (ev.text !== undefined ? ` 文本=${JSON.stringify(ev.text)}` : ` hex=${ev.payload}`),
        );
        break;
      case 'control':
        console.log(
          `控制帧 帧#${ev.frameIndex} ${ev.opcodeName}` +
          (ev.closeCode !== undefined ? ` code=${ev.closeCode} reason=${JSON.stringify(ev.closeReason ?? '')}` : ` payload=${ev.payload}`),
        );
        break;
      case 'error':
        console.log(`错误 ${ev.code} @偏移${ev.offset} 帧#${ev.frameIndex}: ${ev.message}`);
        break;
      case 'incomplete-message':
        console.log(`未完成消息 [${ev.opcodeName}] 已缓冲 ${ev.bufferedBytes}B / ${ev.frameCount} 帧`);
        break;
      case 'eof':
        console.log(`输入结束: ${ev.status} @${ev.offset}`);
        break;
    }
  }
}

function usage() {
  console.log(`用法:
  cli.js new <c2s|s2c>                      新建解析流
  cli.js list                               列出所有流
  cli.js append <id> <seq> <hex|base64> <data>  追加字节块
  cli.js finish <id>                        显式结束输入
  cli.js frames <id>                        查询完整帧
  cli.js messages <id>                      读取完整消息
  cli.js events <id>                        查看全部事件
  cli.js diag <id>                          导出诊断
  cli.js status <id>                        查看流状态`);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case 'new': {
        const dir = args[0] as Direction;
        if (dir !== 'c2s' && dir !== 's2c') throw new ApiError(400, 'BAD_DIRECTION', '方向必须是 c2s 或 s2c');
        const s = store.createStream(dir);
        console.log(`已创建流 ${s.id} 方向=${s.direction}`);
        break;
      }
      case 'list':
        for (const s of store.listStreams()) {
          console.log(`${s.id} ${s.direction} 偏移=${s.streamOffset} 帧=${s.frameIndex}` +
            `${s.frozen ? ' [冻结]' : ''}${s.closed ? ' [已关闭]' : ''}${s.finished ? ' [已结束]' : ''}`);
        }
        break;
      case 'append': {
        const [id, seq, enc, ...rest] = args;
        const events = store.append(id, Number(seq), decode(enc ?? 'hex', rest.join('')));
        printEvents(events);
        break;
      }
      case 'finish':
        printEvents(store.finish(args[0]));
        break;
      case 'frames':
        printEvents(store.frames(args[0]));
        break;
      case 'messages':
        printEvents(store.messages(args[0]));
        break;
      case 'events':
        printEvents(store.events(args[0]));
        break;
      case 'diag':
        console.log(JSON.stringify(store.diagnostics(args[0]), null, 2));
        break;
      case 'status':
        console.log(JSON.stringify(store.getStream(args[0]), null, 2));
        break;
      default:
        usage();
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e: any) {
    if (e instanceof ApiError) {
      console.error(`错误 ${e.code}: ${e.message}`);
      process.exitCode = 1;
    } else throw e;
  } finally {
    store.close();
  }
}

main();
