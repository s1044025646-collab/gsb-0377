// RFC 6455 基础帧格式的增量解析器。
// 只负责 字节 -> 帧 -> 消息 两层状态维护，不涉及任何网络与存储。

export type Direction = 'c2s' | 's2c';

export interface Limits {
  maxStreamBytes: number;   // 单条流累计字节上限
  maxPayloadBytes: number;  // 单帧载荷上限
  maxMessageBytes: number;  // 单条重组消息上限
}

export const DEFAULT_LIMITS: Limits = {
  maxStreamBytes: 16 * 1024 * 1024,
  maxPayloadBytes: 1 * 1024 * 1024,
  maxMessageBytes: 4 * 1024 * 1024,
};

export const OPCODES: Record<number, string> = {
  0x0: 'continuation', 0x1: 'text', 0x2: 'binary',
  0x8: 'close', 0x9: 'ping', 0xa: 'pong',
};

export interface FrameEvent {
  type: 'frame';
  frameIndex: number;
  offset: number;          // 帧头在流内的起始字节偏移
  headerLength: number;
  fin: boolean;
  opcode: number;
  opcodeName: string;
  masked: boolean;
  maskKey?: string;        // hex
  payloadLength: number;
  payload: string;         // 解掩码后的 hex
}

export interface MessageEvent {
  type: 'message';
  messageIndex: number;
  opcodeName: 'text' | 'binary';
  byteLength: number;
  payload: string;         // hex
  text?: string;           // text 消息且 UTF-8 校验通过
  frameCount: number;
}

export interface ControlEvent {
  type: 'control';
  frameIndex: number;
  opcodeName: 'close' | 'ping' | 'pong';
  payload: string;         // hex
  closeCode?: number;
  closeReason?: string;
}

export interface ParseErrorEvent {
  type: 'error';
  code: string;
  message: string;
  offset: number;          // 流内字节偏移
  frameIndex: number;      // 已确认的帧编号（当前正在解析的帧）
}

export interface IncompleteMessageEvent {
  type: 'incomplete-message';
  opcodeName: 'text' | 'binary';
  bufferedBytes: number;
  frameCount: number;
}

export interface EofEvent {
  type: 'eof';
  status: 'clean' | 'truncated-frame' | 'open-message';
  offset: number;
}

export type ParserEvent =
  | FrameEvent | MessageEvent | ControlEvent | ParseErrorEvent
  | IncompleteMessageEvent | EofEvent;

interface FragState {
  opcode: 1 | 2;
  parts: string[];   // 每段解掩码后的 hex
  total: number;
  frameCount: number;
}

interface ParserState {
  buffer: string;        // 尚未构成完整帧的字节，hex
  streamOffset: number;  // 已确认消费的字节数
  frameIndex: number;
  messageIndex: number;
  frag: FragState | null;
  closed: boolean;       // 收到合法 Close
  frozen: boolean;       // 协议错误后冻结
  finished: boolean;
}

const VALID_CLOSE_CODES = new Set([
  1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015,
]);

function isValidCloseCode(code: number): boolean {
  return VALID_CLOSE_CODES.has(code) || (code >= 3000 && code <= 4999);
}

function utf8Strict(buf: Buffer): string | null {
  const dec = new TextDecoder('utf-8', { fatal: true });
  try { return dec.decode(buf); } catch { return null; }
}

export class Parser {
  private st: ParserState;

  constructor(
    public readonly direction: Direction,
    public readonly limits: Limits = DEFAULT_LIMITS,
    state?: ParserState,
  ) {
    this.st = state ?? {
      buffer: '', streamOffset: 0, frameIndex: 0, messageIndex: 0,
      frag: null, closed: false, frozen: false, finished: false,
    };
  }

  get frozen() { return this.st.frozen; }
  get closed() { return this.st.closed; }
  get finished() { return this.st.finished; }
  get frameIndex() { return this.st.frameIndex; }
  get streamOffset() { return this.st.streamOffset; }

  toJSON(): ParserState { return JSON.parse(JSON.stringify(this.st)); }
  static from(direction: Direction, limits: Limits, state: ParserState): Parser {
    return new Parser(direction, limits, state);
  }

  private fail(code: string, message: string): ParseErrorEvent {
    this.st.frozen = true;
    return {
      type: 'error', code, message,
      offset: this.st.streamOffset,
      frameIndex: this.st.frameIndex,
    };
  }

  /** 追加一段字节，返回本次产生的事件。出错后流被冻结。 */
  feed(chunk: Buffer): ParserEvent[] {
    if (this.st.finished) {
      return [this.fail('INPUT_AFTER_FINISH', '输入已显式结束，拒绝继续追加')];
    }
    if (this.st.frozen) {
      return [this.fail('STREAM_FROZEN', '流已因协议错误冻结，拒绝继续追加')];
    }
    if (this.st.closed) {
      return [this.fail('INPUT_AFTER_CLOSE', '已收到合法 Close 帧，解析流已关闭')];
    }
    if (this.st.streamOffset + this.st.buffer.length / 2 + chunk.length > this.limits.maxStreamBytes) {
      return [this.fail('STREAM_TOO_LARGE', '累计字节超过上限')];
    }
    this.st.buffer += chunk.toString('hex');
    return this.drain();
  }

  /** 显式结束输入，区分干净边界 / 半个帧 / 未结束消息。 */
  finish(): ParserEvent[] {
    if (this.st.finished) return [];
    this.st.finished = true;
    const events: ParserEvent[] = [];
    const leftover = this.st.buffer.length / 2;
    if (leftover > 0) {
      events.push(this.fail('TRUNCATED_FRAME', `输入结束时残留 ${leftover} 字节，帧不完整`));
      return events;
    }
    if (this.st.frag) {
      events.push({
        type: 'incomplete-message',
        opcodeName: this.st.frag.opcode === 1 ? 'text' : 'binary',
        bufferedBytes: this.st.frag.total,
        frameCount: this.st.frag.frameCount,
      });
      events.push({ type: 'eof', status: 'open-message', offset: this.st.streamOffset });
      this.st.frag = null;
      return events;
    }
    events.push({ type: 'eof', status: 'clean', offset: this.st.streamOffset });
    return events;
  }

  private drain(): ParserEvent[] {
    const events: ParserEvent[] = [];
    for (;;) {
      const r = this.tryParseFrame();
      if (r === null) break;           // 数据不足，等待更多输入
      if (!Array.isArray(r)) { events.push(r.error); break; }
      events.push(...r);
      if (this.st.frozen || this.st.closed) break;
    }
    return events;
  }

  /** 返回 null 表示数据不足；返回 { error } 表示协议错误；否则返回事件数组。 */
  private tryParseFrame(): ParserEvent[] | { error: ParseErrorEvent } | null {
    const hex = this.st.buffer;
    const avail = hex.length / 2;
    if (avail < 2) return null;
    const b0 = parseInt(hex.slice(0, 2), 16);
    const b1 = parseInt(hex.slice(2, 4), 16);
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    const lenCode = b1 & 0x7f;
    const frameOffset = this.st.streamOffset;
    const frameIndex = this.st.frameIndex;

    if (rsv !== 0) {
      return { error: this.fail('RSV_NONZERO', '未协商扩展时 RSV1/2/3 必须为零') };
    }
    const opcodeName = OPCODES[opcode];
    if (!opcodeName) {
      return { error: this.fail('BAD_OPCODE', `保留 opcode 0x${opcode.toString(16)}`) };
    }
    const isControl = opcode >= 0x8;
    if (this.direction === 'c2s' && !masked) {
      return { error: this.fail('MASK_REQUIRED', '客户端到服务端的帧必须带掩码') };
    }
    if (this.direction === 's2c' && masked) {
      return { error: this.fail('MASK_FORBIDDEN', '服务端到客户端的帧必须不带掩码') };
    }

    let pos = 2;
    let payloadLen: number;
    if (lenCode < 126) {
      payloadLen = lenCode;
    } else if (lenCode === 126) {
      if (avail < pos + 2) return null;
      payloadLen = parseInt(hex.slice(pos * 2, pos * 2 + 4), 16);
      if (payloadLen < 126) {
        return { error: this.fail('NON_MINIMAL_LENGTH', '长度 126 的扩展编码不得用于小于 126 的载荷') };
      }
      pos += 2;
    } else {
      if (avail < pos + 8) return null;
      const hi = parseInt(hex.slice(pos * 2, pos * 2 + 8), 16);
      if (hi & 0x80000000) {
        return { error: this.fail('LENGTH_MSB_SET', '64 位长度最高位必须为零') };
      }
      const lo = parseInt(hex.slice(pos * 2 + 8, pos * 2 + 16), 16);
      payloadLen = hi * 2 ** 32 + lo;
      if (payloadLen < 65536) {
        return { error: this.fail('NON_MINIMAL_LENGTH', '长度 127 的扩展编码不得用于小于 65536 的载荷') };
      }
      pos += 8;
    }
    if (payloadLen > this.limits.maxPayloadBytes) {
      return { error: this.fail('PAYLOAD_TOO_LARGE', `载荷 ${payloadLen} 字节超过单帧上限`) };
    }
    if (isControl) {
      if (!fin) return { error: this.fail('CONTROL_FRAGMENTED', '控制帧必须是最终帧（FIN=1）') };
      if (payloadLen > 125) return { error: this.fail('CONTROL_TOO_LARGE', '控制帧载荷不得超过 125 字节') };
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (avail < pos + 4) return null;
      maskKey = Buffer.from(hex.slice(pos * 2, pos * 2 + 8), 'hex');
      pos += 4;
    }
    if (avail < pos + payloadLen) return null; // 等待正文完整，掩码偏移始终以载荷起点为 0

    const payload = Buffer.from(hex.slice(pos * 2, (pos + payloadLen) * 2), 'hex');
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    const headerLength = pos;
    // 消费该帧
    this.st.buffer = hex.slice((pos + payloadLen) * 2);
    this.st.streamOffset += pos + payloadLen;
    this.st.frameIndex += 1;

    const events: ParserEvent[] = [];
    events.push({
      type: 'frame', frameIndex, offset: frameOffset, headerLength,
      fin, opcode, opcodeName, masked,
      ...(maskKey ? { maskKey: maskKey.toString('hex') } : {}),
      payloadLength: payloadLen, payload: payload.toString('hex'),
    });

    if (isControl) {
      const ev = this.handleControl(opcode, payload, frameIndex);
      if (ev.type === 'error') {
        ev.offset = frameOffset;
        ev.frameIndex = frameIndex;
        return { error: ev };
      }
      events.push(ev);
      return events;
    }
    const err = this.handleData(opcode as 0 | 1 | 2, fin, payload, events);
    if (err) {
      err.offset = frameOffset;
      err.frameIndex = frameIndex;
      return { error: err };
    }
    return events;
  }

  private handleControl(opcode: number, payload: Buffer, frameIndex: number): ControlEvent | ParseErrorEvent {
    const name = OPCODES[opcode] as 'close' | 'ping' | 'pong';
    if (opcode !== 0x8) {
      return { type: 'control', frameIndex, opcodeName: name, payload: payload.toString('hex') };
    }
    // Close 帧校验
    if (payload.length === 1) {
      return this.fail('CLOSE_LEN_ONE', 'Close 载荷长度为 1 非法');
    }
    let closeCode: number | undefined;
    let closeReason: string | undefined;
    if (payload.length >= 2) {
      closeCode = payload.readUInt16BE(0);
      if (!isValidCloseCode(closeCode)) {
        return this.fail('BAD_CLOSE_CODE', `Close 状态码 ${closeCode} 不在合法范围`);
      }
      const reason = payload.subarray(2);
      if (reason.length > 0) {
        const text = utf8Strict(reason);
        if (text === null) return this.fail('CLOSE_REASON_UTF8', 'Close 原因不是合法 UTF-8');
        closeReason = text;
      }
    }
    this.st.closed = true;
    return {
      type: 'control', frameIndex, opcodeName: 'close',
      payload: payload.toString('hex'),
      ...(closeCode !== undefined ? { closeCode } : {}),
      ...(closeReason !== undefined ? { closeReason } : {}),
    };
  }

  private handleData(opcode: 0 | 1 | 2, fin: boolean, payload: Buffer, events: ParserEvent[]): ParseErrorEvent | null {
    if (opcode === 0) {
      if (!this.st.frag) {
        return this.fail('UNEXPECTED_CONTINUATION', '没有开放消息时出现 continuation 帧');
      }
    } else {
      if (this.st.frag) {
        return this.fail('MESSAGE_NOT_FINISHED', '已有分片消息未结束时出现新的数据首帧');
      }
      this.st.frag = { opcode, parts: [], total: 0, frameCount: 0 };
    }
    const frag = this.st.frag!;
    frag.parts.push(payload.toString('hex'));
    frag.total += payload.length;
    frag.frameCount += 1;
    if (frag.total > this.limits.maxMessageBytes) {
      return this.fail('MESSAGE_TOO_LARGE', '重组消息超过大小上限');
    }
    if (!fin) return null;

    const full = Buffer.from(frag.parts.join(''), 'hex');
    const msg: MessageEvent = {
      type: 'message',
      messageIndex: this.st.messageIndex++,
      opcodeName: frag.opcode === 1 ? 'text' : 'binary',
      byteLength: full.length,
      payload: full.toString('hex'),
      frameCount: frag.frameCount,
    };
    if (frag.opcode === 1) {
      const text = utf8Strict(full); // 整条消息重组后严格校验，允许多字节字符跨帧
      if (text === null) {
        return this.fail('INVALID_UTF8', '文本消息不是合法 UTF-8');
      }
      msg.text = text;
    }
    this.st.frag = null;
    events.push(msg);
    return null;
  }
}
