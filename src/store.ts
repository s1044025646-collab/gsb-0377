import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ParserState } from './parser.js';

export interface StreamRow {
  id: string;
  direction: string;
  state: string; // ParserState JSON
  nextSeq: number;
  finished: number;
  createdAt: string;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        state TEXT NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (stream_id, seq)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        seq INTEGER,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream_id, id);
    `);
  }

  createStream(id: string, direction: string, state: ParserState): void {
    this.db
      .prepare('INSERT INTO streams (id, direction, state, next_seq, finished, created_at) VALUES (?, ?, ?, 0, 0, ?)')
      .run(id, direction, JSON.stringify(state), new Date().toISOString());
  }

  getStream(id: string): StreamRow | null {
    const row = this.db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      direction: row.direction,
      state: row.state,
      nextSeq: row.next_seq,
      finished: row.finished,
      createdAt: row.created_at,
    };
  }

  getChunk(streamId: string, seq: number): { sha256: string } | null {
    const row = this.db.prepare('SELECT sha256 FROM chunks WHERE stream_id = ? AND seq = ?').get(streamId, seq) as any;
    return row ? { sha256: row.sha256 } : null;
  }

  /** 原子提交一次追加：保存字节块、事件与最新解析状态。 */
  commitAppend(streamId: string, seq: number, sha256: string, data: Buffer, state: ParserState, events: unknown[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO chunks (stream_id, seq, sha256, data) VALUES (?, ?, ?, ?)').run(streamId, seq, sha256, data);
      const stmt = this.db.prepare('INSERT INTO events (stream_id, seq, json) VALUES (?, ?, ?)');
      for (const ev of events) stmt.run(streamId, seq, JSON.stringify(ev));
      this.db.prepare('UPDATE streams SET state = ?, next_seq = ? WHERE id = ?').run(JSON.stringify(state), seq + 1, streamId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  commitEvents(streamId: string, state: ParserState, events: unknown[], finished: boolean): void {
    this.db.exec('BEGIN');
    try {
      const stmt = this.db.prepare('INSERT INTO events (stream_id, seq, json) VALUES (?, NULL, ?)');
      for (const ev of events) stmt.run(streamId, JSON.stringify(ev));
      this.db
        .prepare('UPDATE streams SET state = ?, finished = ? WHERE id = ?')
        .run(JSON.stringify(state), finished ? 1 : 0, streamId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getEvents(streamId: string): unknown[] {
    const rows = this.db.prepare('SELECT json FROM events WHERE stream_id = ? ORDER BY id').all(streamId) as any[];
    return rows.map((r) => JSON.parse(r.json));
  }

  close(): void {
    this.db.close();
  }
}
