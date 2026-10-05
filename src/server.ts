// 纯 node:http 的 JSON API 服务。
import * as http from 'node:http';
import * as path from 'node:path';
import { Store, ApiError } from './store';
import { Direction } from './parser';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'ws-parser.db');

function decodeData(encoding: string, data: string): Buffer {
  if (encoding === 'hex') {
    if (!/^[0-9a-fA-F]*$/.test(data) || data.length % 2 !== 0) {
      throw new ApiError(400, 'BAD_ENCODING', 'hex 数据非法');
    }
    return Buffer.from(data, 'hex');
  }
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new ApiError(400, 'BAD_ENCODING', 'base64 数据非法');
    }
    return Buffer.from(data, 'base64');
  }
  throw new ApiError(400, 'BAD_ENCODING', 'encoding 必须是 hex 或 base64');
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

export function createServer(store: Store) {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: any) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(s);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        return send(200, { ok: true });
      }
      if (method === 'POST' && url.pathname === '/streams') {
        const body = await readBody(req);
        if (body.direction !== 'c2s' && body.direction !== 's2c') {
          throw new ApiError(400, 'BAD_DIRECTION', 'direction 必须是 c2s 或 s2c');
        }
        return send(201, store.createStream(body.direction as Direction, body.limits));
      }
      if (method === 'GET' && url.pathname === '/streams') {
        return send(200, store.listStreams());
      }
      if (parts[0] === 'streams' && parts.length >= 2) {
        const id = parts[1];
        const sub = parts[2];
        if (method === 'GET' && !sub) return send(200, store.getStream(id));
        if (method === 'POST' && sub === 'chunks') {
          const body = await readBody(req);
          if (typeof body.data !== 'string') {
            throw new ApiError(400, 'BAD_REQUEST', '缺少 data 字段');
          }
          const buf = decodeData(body.encoding ?? 'hex', body.data);
          return send(200, { events: store.append(id, body.seq, buf) });
        }
        if (method === 'POST' && sub === 'finish') {
          return send(200, { events: store.finish(id) });
        }
        if (method === 'GET' && sub === 'frames') return send(200, store.frames(id));
        if (method === 'GET' && sub === 'messages') return send(200, store.messages(id));
        if (method === 'GET' && sub === 'events') return send(200, store.events(id));
        if (method === 'GET' && sub === 'diagnostics') return send(200, store.diagnostics(id));
      }
      throw new ApiError(404, 'NOT_FOUND', '路由不存在');
    } catch (e: any) {
      if (e instanceof ApiError) {
        return send(e.status, { error: { code: e.code, message: e.message } });
      }
      return send(500, { error: { code: 'INTERNAL', message: String(e?.message ?? e) } });
    }
  });
}

export async function start(port?: number): Promise<{ server: http.Server; port: number }> {
  const store = new Store(DB_PATH);
  const server = createServer(store);
  const p = port ?? (process.env.PORT ? Number(process.env.PORT) : 0); // 默认选择空闲端口
  await new Promise<void>((resolve) => server.listen(p, resolve));
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : p;
  return { server, port: actual };
}

if (require.main === module) {
  const argPort = process.argv.find((a) => a.startsWith('--port='));
  const port = argPort ? Number(argPort.split('=')[1]) : undefined;
  start(port).then(({ port }) => {
    console.log(`WebSocket 帧解析服务已启动: http://127.0.0.1:${port}`);
    console.log(`数据目录: ${DATA_DIR}`);
  });
}
