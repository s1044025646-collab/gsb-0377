import { createHash, randomUUID } from 'node:crypto';
import { Parser, type Direction, type Limits, type ParserEvent, type ParserState } from './parser.js';
import { Store } from './store.js';
import { ApiError } from './errors.js';

export interface AppendResult {
  streamId: string;
  seq: number;
  idempotent: boolean;
  events: ParserEvent[];
  status: StreamStatus;
}

export interface StreamStatus {
  id: string;
  direction: Direction;
  consumedBytes: number;
  totalReceived: number;
  bufferedBytes: number;
  frameCount: number;
  messageCount: number;
  hasOpenFragment: boolean;
  closed: boolean;
  frozen: boolean;
  finished: boolean;
  nextSeq: number;
}

function decodeData(encoding: string, data: string): Buffer {
  if (encoding === 'hex') {
    if (!/^[0-9a-fA-F]*$/.test(data) || data.length % 2 !== 0) {
      throw new ApiError('ENCODING_ERROR', 'hex 编码非法：必须为偶数长度的十六进制字符');
    }
    return Buffer.from(data, 'hex');
  }
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new ApiError('ENCODING_ERROR', 'base64 编码非法');
    }
    return Buffer.from(data, 'base64');
  }
  throw new ApiError('INVALID_INPUT', `不支持的编码：${encoding}（仅支持 hex / base64）`);
}

export class StreamService {
  constructor(private store: Store) {}

  createStream(opts: { direction: Direction; limits?: Partial<Limits>; id?: string }): StreamStatus {
    if (opts.direction !== 'c2s' && opts.direction !== 's2c') {
      throw new ApiError('INVALID_INPUT', 'direction 必须为 c2s 或 s2c');
    }
    const id = opts.id ?? randomUUID();
    if (this.store.getStream(id)) throw new ApiError('INVALID_INPUT', `流 ${id} 已存在`);
    const parser = new Parser(opts.direction, opts.limits);
    this.store.createStream(id, opts.direction, parser.state);
    return this.status(id);
  }

  private load(id: string): { parser: Parser; row: NonNullable<ReturnType<Store['getStream']>> } {
    const row = this.store.getStream(id);
    if (!row) throw new ApiError('NOT_FOUND', `流 ${id} 不存在`);
    return { parser: new Parser(row.direction as Direction, undefined, JSON.parse(row.state) as ParserState), row };
  }

  append(id: string, seq: number, encoding: string, data: string): AppendResult {
    if (!Number.isInteger(seq) || seq < 0) throw new ApiError('INVALID_INPUT', 'seq 必须为不小于 0 的整数');
    const bytes = decodeData(encoding, data);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { parser, row } = this.load(id);

    if (seq < row.nextSeq) {
      const existing = this.store.getChunk(id, seq);
      if (existing && existing.sha256 === sha256) {
        return { streamId: id, seq, idempotent: true, events: [], status: this.status(id) };
      }
      throw new ApiError('SEQ_CONFLICT', `序号冲突：序号 ${seq} 已提交过不同内容`, { seq });
    }
    if (seq > row.nextSeq) {
      throw new ApiError('SEQ_CONFLICT', `序号不连续：期望 ${row.nextSeq}，收到 ${seq}`, { expected: row.nextSeq });
    }
    if (parser.state.frozen) {
      throw new ApiError('STREAM_FROZEN', '流因协议错误已冻结，拒绝后续输入');
    }
    if (parser.state.closed) {
      throw new ApiError('STREAM_CLOSED', '流已收到合法 Close 帧并关闭，拒绝后续输入');
    }
    if (row.finished) {
      throw new ApiError('STREAM_CLOSED', '流已显式结束输入，拒绝后续追加');
    }

    const events = parser.feed(bytes);
    this.store.commitAppend(id, seq, sha256, bytes, parser.state, events);
    return { streamId: id, seq, idempotent: false, events, status: this.status(id) };
  }

  finish(id: string): { events: ParserEvent[]; status: StreamStatus } {
    const { parser, row } = this.load(id);
    if (row.finished) return { events: [], status: this.status(id) };
    const events = parser.finish();
    this.store.commitEvents(id, parser.state, events, true);
    return { events, status: this.status(id) };
  }

  status(id: string): StreamStatus {
    const { parser, row } = this.load(id);
    const s = parser.state;
    return {
      id,
      direction: s.direction,
      consumedBytes: s.consumed,
      totalReceived: s.totalReceived,
      bufferedBytes: Buffer.from(s.bufferB64, 'base64').length,
      frameCount: s.frameIndex,
      messageCount: s.messageIndex,
      hasOpenFragment: s.fragment !== null,
      closed: s.closed,
      frozen: s.frozen,
      finished: row.finished === 1,
      nextSeq: row.nextSeq,
    };
  }

  frames(id: string): unknown[] {
    this.load(id);
    return this.store.getEvents(id).filter((e: any) => e.kind === 'frame');
  }

  messages(id: string): unknown[] {
    this.load(id);
    return this.store.getEvents(id).filter((e: any) => e.kind === 'message');
  }

  diagnostics(id: string): { status: StreamStatus; errors: unknown[]; events: unknown[] } {
    const status = this.status(id);
    const events = this.store.getEvents(id);
    return { status, errors: events.filter((e: any) => e.kind === 'error'), events };
  }
}
