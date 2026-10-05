import { join } from 'node:path';
import { Store } from './store.js';
import { StreamService } from './service.js';
import { startServer } from './server.js';
import { ApiError } from './errors.js';

const DATA_DIR = process.env.WSP_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = process.env.WSP_DB ?? join(DATA_DIR, 'wsparse.db');

function fmtFrame(f: any): string {
  const mask = f.masked ? ` mask=${f.maskKeyHex}` : '';
  return `帧#${f.frameIndex} @字节${f.offset} ${f.opcodeName} FIN=${f.fin ? 1 : 0} 头长=${f.headerLength} 载荷=${f.payloadLength}${mask} 数据=${f.payloadHex}`;
}

function fmtMessage(m: any): string {
  const body = m.type === 'text' ? `文本=${JSON.stringify(m.text)}` : `数据=${m.payloadHex}`;
  return `消息#${m.messageIndex} ${m.type} 帧数=${m.frameCount} 字节=${m.byteLength} ${body}`;
}

function fmtError(e: any): string {
  return `错误[${e.code}] @字节${e.byteOffset} 已确认帧#${e.frameIndex}：${e.message}`;
}

function printEvents(events: any[]): void {
  for (const e of events) {
    if (e.kind === 'frame') console.log('  ' + fmtFrame(e));
    else if (e.kind === 'message') console.log('  ' + fmtMessage(e));
    else console.log('  ' + fmtError(e));
  }
}

function usage(): void {
  console.log(`用法：node dist/cli.js <命令> [参数]
  serve [--port N]                      启动 HTTP API（默认端口 0，即自动选空闲端口）
  create <c2s|s2c> [id]                 新建解析流
  append <id> <seq> <hex|base64> <data> 追加字节块（序号幂等）
  finish <id>                           显式结束输入
  status <id>                           查询流状态
  frames <id>                           列出已解析帧（含流内字节偏移）
  messages <id>                         读取完整重组消息
  diag <id>                             导出诊断（状态/错误/全部事件）
环境变量：WSP_DATA_DIR 数据目录（默认 ./data），WSP_DB 数据库文件路径`);
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  const store = new Store(DB_PATH);
  const service = new StreamService(store);
  try {
    switch (cmd) {
      case 'serve': {
        const idx = args.indexOf('--port');
        const port = idx >= 0 ? Number(args[idx + 1]) : Number(process.env.PORT ?? 0);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ApiError('INVALID_INPUT', '端口非法');
        const actual = await startServer(service, port);
        console.log(`HTTP API 已启动：http://127.0.0.1:${actual}（数据目录 ${DATA_DIR}）`);
        return; // 保持进程存活
      }
      case 'create': {
        const direction = args[0] as any;
        const st = service.createStream({ direction, id: args[1] });
        console.log(JSON.stringify(st, null, 2));
        break;
      }
      case 'append': {
        const [id, seq, enc, data] = args;
        const r = service.append(id, Number(seq), enc ?? 'hex', data ?? '');
        console.log(`seq=${r.seq} idempotent=${r.idempotent} 事件 ${r.events.length} 条：`);
        printEvents(r.events);
        break;
      }
      case 'finish': {
        const r = service.finish(args[0]);
        console.log('结束输入，事件：');
        printEvents(r.events);
        console.log(JSON.stringify(r.status, null, 2));
        break;
      }
      case 'status':
        console.log(JSON.stringify(service.status(args[0]), null, 2));
        break;
      case 'frames':
        for (const f of service.frames(args[0]) as any[]) console.log(fmtFrame(f));
        break;
      case 'messages':
        for (const m of service.messages(args[0]) as any[]) console.log(fmtMessage(m));
        break;
      case 'diag': {
        const d = service.diagnostics(args[0]);
        console.log('状态：' + JSON.stringify(d.status));
        console.log('错误：');
        for (const e of d.errors as any[]) console.log('  ' + fmtError(e));
        console.log('全部事件：');
        printEvents(d.events as any[]);
        break;
      }
      default:
        usage();
        if (cmd) process.exitCode = 2;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`错误[${e.code}] ${e.message}`);
      process.exitCode = 1;
    } else throw e;
  } finally {
    if (cmd !== 'serve') store.close();
  }
}

main();
