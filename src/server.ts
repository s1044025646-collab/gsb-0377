import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamService } from './service.js';
import { ApiError } from './errors.js';

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError('INVALID_INPUT', '请求体必须是合法 JSON');
  }
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function startServer(service: StreamService, port: number): Promise<number> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'POST' && url.pathname === '/streams') {
        const body = await readBody(req);
        return send(res, 201, service.createStream(body));
      }
      if (parts[0] === 'streams' && parts.length >= 2) {
        const id = decodeURIComponent(parts[1]);
        const action = parts[2];
        if (method === 'GET' && !action) return send(res, 200, service.status(id));
        if (method === 'POST' && action === 'chunks') {
          const body = await readBody(req);
          return send(res, 200, service.append(id, body.seq, body.encoding ?? 'hex', body.data ?? ''));
        }
        if (method === 'POST' && action === 'finish') return send(res, 200, service.finish(id));
        if (method === 'GET' && action === 'frames') return send(res, 200, service.frames(id));
        if (method === 'GET' && action === 'messages') return send(res, 200, service.messages(id));
        if (method === 'GET' && action === 'diagnostics') return send(res, 200, service.diagnostics(id));
      }
      throw new ApiError('NOT_FOUND', `未知路由 ${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof ApiError) {
        const status =
          e.code === 'NOT_FOUND' ? 404 : e.code === 'SEQ_CONFLICT' ? 409 : e.code.startsWith('STREAM_') ? 410 : 400;
        return send(res, status, { error: { code: e.code, message: e.message, details: e.details ?? null } });
      }
      return send(res, 500, { error: { code: 'INTERNAL', message: String(e) } });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}
