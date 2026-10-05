// SQLite 持久层：流、字节块、事件三张表，追加操作在事务中原子完成。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  Parser, ParserEvent, Direction, Limits, DEFAULT_LIMITS,
} from './parser';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface StreamInfo {
  id: string;
  direction: Direction;
  limits: Limits;
  nextSeq: number;
  streamOffset: number;
  frameIndex: number;
  closed: boolean;
  frozen: boolean;
  finished: boolean;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        limits TEXT NOT NULL,
        state TEXT NOT NULL,
        next_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (stream_id, seq)
      );
      CREATE TABLE IF NOT EXISTS events (
        stream_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (stream_id, idx)
      );
    `);
  }

  close() { this.db.close(); }

  createStream(direction: Direction, limits?: Partial<Limits>): StreamInfo {
    const full: Limits = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
    for (const k of ['maxStreamBytes', 'maxPayloadBytes', 'maxMessageBytes'] as const) {
      if (!Number.isInteger(full[k]) || full[k] <= 0) {
        throw new ApiError(400, 'BAD_LIMITS', `limits.${k} 必须为正整数`);
      }
    }
    const parser = new Parser(direction, full);
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO streams (id, direction, limits, state, next_seq, created_at) VALUES (?,?,?,?,?,?)',
    ).run(id, direction, JSON.stringify(full), JSON.stringify(parser.toJSON()), 0, new Date().toISOString());
    return this.getStream(id);
  }

  private row(id: string) {
    const r = this.db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as any;
    if (!r) throw new ApiError(404, 'NOT_FOUND', `流 ${id} 不存在`);
    return r;
  }

  getStream(id: string): StreamInfo {
    const r = this.row(id);
    const st = JSON.parse(r.state);
    return {
      id: r.id,
      direction: r.direction,
      limits: JSON.parse(r.limits),
      nextSeq: r.next_seq,
      streamOffset: st.streamOffset,
      frameIndex: st.frameIndex,
      closed: st.closed,
      frozen: st.frozen,
      finished: st.finished,
      createdAt: r.created_at,
    };
  }

  listStreams(): StreamInfo[] {
    const rows = this.db.prepare('SELECT id FROM streams ORDER BY created_at').all() as any[];
    return rows.map((r) => this.getStream(r.id));
  }

  private loadParser(id: string): Parser {
    const r = this.row(id);
    return Parser.from(r.direction, JSON.parse(r.limits), JSON.parse(r.state));
  }

  /** 幂等追加：相同 seq 相同内容直接返回空事件；内容不同报冲突。 */
  append(id: string, seq: number, data: Buffer): ParserEvent[] {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new ApiError(400, 'BAD_SEQ', 'seq 必须为不小于 0 的整数');
    }
    const info = this.getStream(id);
    const existing = this.db.prepare(
      'SELECT data FROM chunks WHERE stream_id = ? AND seq = ?',
    ).get(id, seq) as any;
    if (existing) {
      const prev = Buffer.from(existing.data);
      if (!prev.equals(data)) {
        throw new ApiError(409, 'SEQ_CONFLICT', `序号 ${seq} 已存在且内容不同`);
      }
      return []; // 幂等重放
    }
    if (seq !== info.nextSeq) {
      throw new ApiError(409, 'SEQ_GAP', `期望序号 ${info.nextSeq}，收到 ${seq}`);
    }
    const parser = this.loadParser(id);
    const events = parser.feed(data);
    this.persist(id, seq, data, parser, events);
    return events;
  }

  finish(id: string): ParserEvent[] {
    const parser = this.loadParser(id);
    const events = parser.finish();
    this.persist(id, null, null, parser, events);
    return events;
  }

  private persist(id: string, seq: number | null, data: Buffer | null, parser: Parser, events: ParserEvent[]) {
    this.db.exec('BEGIN');
    try {
      if (seq !== null && data !== null) {
        this.db.prepare('INSERT INTO chunks (stream_id, seq, data) VALUES (?,?,?)').run(id, seq, data);
      }
      const cur = this.db.prepare(
        'SELECT COALESCE(MAX(idx), -1) AS m FROM events WHERE stream_id = ?',
      ).get(id) as any;
      let idx = (cur.m as number) + 1;
      const ins = this.db.prepare('INSERT INTO events (stream_id, idx, json) VALUES (?,?,?)');
      for (const ev of events) ins.run(id, idx++, JSON.stringify(ev));
      this.db.prepare('UPDATE streams SET state = ?, next_seq = next_seq + ? WHERE id = ?')
        .run(JSON.stringify(parser.toJSON()), seq !== null ? 1 : 0, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  events(id: string, type?: string): ParserEvent[] {
    this.row(id);
    const rows = this.db.prepare(
      'SELECT json FROM events WHERE stream_id = ? ORDER BY idx',
    ).all(id) as any[];
    const all = rows.map((r) => JSON.parse(r.json) as ParserEvent);
    return type ? all.filter((e) => e.type === type) : all;
  }

  frames(id: string) { return this.events(id, 'frame'); }
  messages(id: string) { return this.events(id, 'message'); }

  diagnostics(id: string) {
    const info = this.getStream(id);
    const all = this.events(id);
    return {
      stream: info,
      counts: {
        frames: all.filter((e) => e.type === 'frame').length,
        messages: all.filter((e) => e.type === 'message').length,
        controls: all.filter((e) => e.type === 'control').length,
        errors: all.filter((e) => e.type === 'error').length,
      },
      errors: all.filter((e) => e.type === 'error'),
      incomplete: all.filter((e) => e.type === 'incomplete-message'),
      eof: all.filter((e) => e.type === 'eof'),
      events: all,
    };
  }
}
