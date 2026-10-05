import { TextDecoder } from 'node:util';

export type Direction = 'c2s' | 's2c';

export interface Limits {
  maxTotalBytes: number;
  maxFramePayload: number;
  maxMessageSize: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTotalBytes: 16 * 1024 * 1024,
  maxFramePayload: 1 * 1024 * 1024,
  maxMessageSize: 4 * 1024 * 1024,
};

export const OPCODE_NAMES: Record<number, string> = {
  0x0: 'continuation',
  0x1: 'text',
  0x2: 'binary',
  0x8: 'close',
  0x9: 'ping',
  0xa: 'pong',
};

export interface FrameEvent {
  kind: 'frame';
  frameIndex: number;
  offset: number;
  headerLength: number;
  fin: boolean;
  rsv: number;
  opcode: number;
  opcodeName: string;
  masked: boolean;
  maskKeyHex: string | null;
  payloadLength: number;
  payloadHex: string; // 已解掩码后的载荷
}

export interface MessageEvent {
  kind: 'message';
  messageIndex: number;
  type: 'text' | 'binary';
  frameCount: number;
  byteLength: number;
  text?: string;
  payloadHex?: string;
}

export interface ProtocolErrorEvent {
  kind: 'error';
  code: string;
  message: string;
  byteOffset: number;
  frameIndex: number;
}

export type ParserEvent = FrameEvent | MessageEvent | ProtocolErrorEvent;

export interface FragmentState {
  opcode: 1 | 2;
  chunks: string[]; // base64
  totalSize: number;
  frameCount: number;
  startFrameIndex: number;
}

export interface ParserState {
  direction: Direction;
  limits: Limits;
  bufferB64: string;
  consumed: number; // buffer 之前已消费的字节数（buffer[0] 的绝对偏移）
  totalReceived: number;
  frameIndex: number;
  messageIndex: number;
  fragment: FragmentState | null;
  closed: boolean;
  frozen: boolean;
}

function utf8StrictDecode(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export function isValidCloseCode(code: number): boolean {
  if (code >= 1000 && code <= 1014) {
    return ![1004, 1005, 1006, 1015].includes(code);
  }
  return code >= 3000 && code <= 4999;
}

export class Parser {
  state: ParserState;

  constructor(direction: Direction, limits?: Partial<Limits>, state?: ParserState) {
    if (state) {
      this.state = state;
    } else {
      this.state = {
        direction,
        limits: { ...DEFAULT_LIMITS, ...(limits ?? {}) },
        bufferB64: '',
        consumed: 0,
        totalReceived: 0,
        frameIndex: 0,
        messageIndex: 0,
        fragment: null,
        closed: false,
        frozen: false,
      };
    }
  }

  private get buffer(): Buffer {
    return Buffer.from(this.state.bufferB64, 'base64');
  }

  private set buffer(b: Buffer) {
    this.state.bufferB64 = b.toString('base64');
  }

  /** 追加字节并尽可能多地解析，返回本次产生的事件。 */
  feed(chunk: Buffer): ParserEvent[] {
    const s = this.state;
    if (s.frozen) return [];
    if (s.closed) {
      return [this.error('STREAM_CLOSED', '连接已发送 Close 帧，流已关闭，拒绝后续输入', s.consumed)];
    }
    s.totalReceived += chunk.length;
    if (s.totalReceived > s.limits.maxTotalBytes) {
      return [this.freeze('LIMIT_EXCEEDED', `累计字节超过上限 ${s.limits.maxTotalBytes}`)];
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: ParserEvent[] = [];
    for (;;) {
      const frame = this.tryParseFrame();
      if (!frame) break;
      if (frame.kind === 'error') {
        events.push(frame);
        break; // 协议错误，流已冻结
      }
      events.push(frame);
      const followUp = this.handleFrame(frame);
      events.push(...followUp);
      if (s.frozen || s.closed) break;
    }
    return events;
  }

  /** 显式结束输入，返回诊断事件（若有）。 */
  finish(): ParserEvent[] {
    const s = this.state;
    if (s.frozen) return [];
    const events: ParserEvent[] = [];
    if (this.buffer.length > 0) {
      events.push(
        this.error(
          'TRUNCATED_FRAME',
          `输入结束时仍有 ${this.buffer.length} 字节未构成完整帧（半个帧）`,
          s.consumed
        )
      );
    }
    if (s.fragment) {
      events.push(
        this.error(
          'UNFINISHED_MESSAGE',
          `输入结束时存在未结束的分片消息（起始帧 #${s.fragment.startFrameIndex}，已收 ${s.fragment.frameCount} 帧，${s.fragment.totalSize} 字节），不输出伪造完整消息`,
          s.consumed
        )
      );
      s.fragment = null;
    }
    return events;
  }

  private error(code: string, message: string, byteOffset: number): ProtocolErrorEvent {
    return { kind: 'error', code, message, byteOffset, frameIndex: this.state.frameIndex };
  }

  private freeze(code: string, message: string): ProtocolErrorEvent {
    this.state.frozen = true;
    return this.error(code, message, this.state.consumed);
  }

  private freezeAt(code: string, message: string, frame: FrameEvent): ProtocolErrorEvent {
    this.state.frozen = true;
    return { kind: 'error', code, message, byteOffset: frame.offset, frameIndex: frame.frameIndex };
  }

  /** 尝试从 buffer 解析一个完整帧；数据不足返回 null；协议错误返回错误事件并冻结。 */
  private tryParseFrame(): FrameEvent | ProtocolErrorEvent | null {
    const s = this.state;
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const frameOffset = s.consumed;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = (b0 >> 4) & 0x7;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    const len7 = b1 & 0x7f;

    if (rsv !== 0) {
      return this.freeze('PROTOCOL_ERROR', `未协商扩展时 RSV 必须为零，实际 RSV=${rsv}`);
    }
    if (!(opcode in OPCODE_NAMES)) {
      return this.freeze('PROTOCOL_ERROR', `非法 opcode 0x${opcode.toString(16)}`);
    }
    if (s.direction === 'c2s' && !masked) {
      return this.freeze('PROTOCOL_ERROR', '客户端到服务端的帧必须带掩码');
    }
    if (s.direction === 's2c' && masked) {
      return this.freeze('PROTOCOL_ERROR', '服务端到客户端的帧必须不带掩码');
    }

    let headerLen = 2;
    let payloadLen: number;
    if (len7 < 126) {
      payloadLen = len7;
    } else if (len7 === 126) {
      headerLen += 2;
      if (buf.length < headerLen) return null;
      payloadLen = buf.readUInt16BE(2);
      if (payloadLen < 126) {
        return this.freeze('PROTOCOL_ERROR', `不规范长度编码：${payloadLen} 应使用基本长度而非 16 位扩展长度`);
      }
    } else {
      headerLen += 8;
      if (buf.length < headerLen) return null;
      if (buf[2] & 0x80) {
        return this.freeze('PROTOCOL_ERROR', '64 位扩展长度最高位非法置位');
      }
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        return this.freeze('LIMIT_EXCEEDED', '载荷长度超过可安全表示范围');
      }
      payloadLen = Number(big);
      if (payloadLen < 65536) {
        return this.freeze('PROTOCOL_ERROR', `不规范长度编码：${payloadLen} 应使用更短的长度编码`);
      }
    }

    const isControl = opcode >= 0x8;
    if (isControl) {
      if (!fin) {
        return this.freeze('PROTOCOL_ERROR', `控制帧 ${OPCODE_NAMES[opcode]} 必须为最终帧（FIN=1）`);
      }
      if (payloadLen > 125) {
        return this.freeze('PROTOCOL_ERROR', `控制帧载荷 ${payloadLen} 字节超过 125 上限`);
      }
    }
    if (payloadLen > s.limits.maxFramePayload) {
      return this.freeze('LIMIT_EXCEEDED', `帧载荷 ${payloadLen} 超过上限 ${s.limits.maxFramePayload}`);
    }

    headerLen += masked ? 4 : 0;
    if (buf.length < headerLen + payloadLen) return null;

    const maskKey = masked ? buf.subarray(headerLen - 4, headerLen) : null;
    let payload = Buffer.from(buf.subarray(headerLen, headerLen + payloadLen));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    this.buffer = buf.subarray(headerLen + payloadLen);
    s.consumed += headerLen + payloadLen;

    const frame: FrameEvent = {
      kind: 'frame',
      frameIndex: s.frameIndex,
      offset: frameOffset,
      headerLength: headerLen,
      fin,
      rsv,
      opcode,
      opcodeName: OPCODE_NAMES[opcode],
      masked,
      maskKeyHex: maskKey ? maskKey.toString('hex') : null,
      payloadLength: payloadLen,
      payloadHex: payload.toString('hex'),
    };
    s.frameIndex += 1;
    return frame;
  }

  /** 帧层通过后的消息层处理，可能产生 message / error 事件。 */
  private handleFrame(frame: FrameEvent): ParserEvent[] {
    const s = this.state;
    const events: ParserEvent[] = [];
    const payload = Buffer.from(frame.payloadHex, 'hex');

    if (frame.opcode === 0x8) {
      // Close
      if (frame.payloadLength === 1) {
        events.push(this.freezeAt('PROTOCOL_ERROR', 'Close 载荷长度为 1 非法（要么为空，要么至少含 2 字节状态码）', frame));
        return events;
      }
      if (frame.payloadLength >= 2) {
        const code = payload.readUInt16BE(0);
        if (!isValidCloseCode(code)) {
          events.push(this.freezeAt('PROTOCOL_ERROR', `Close 状态码 ${code} 不在公开的基础合法码范围`, frame));
          return events;
        }
        const reason = payload.subarray(2);
        if (reason.length > 0 && utf8StrictDecode(reason) === null) {
          events.push(this.freezeAt('PROTOCOL_ERROR', 'Close 原因文本不是合法 UTF-8', frame));
          return events;
        }
      }
      s.closed = true;
      if (s.fragment) {
        events.push(
          this.error(
            'UNFINISHED_MESSAGE',
            `Close 到达时仍有未结束的分片消息（起始帧 #${s.fragment.startFrameIndex}），记录为未完成`,
            s.consumed
          )
        );
        s.fragment = null;
      }
      return events;
    }

    if (frame.opcode === 0x9 || frame.opcode === 0xa) {
      // Ping/Pong：只报告，不拼入用户消息，不做网络应答
      return events;
    }

    if (frame.opcode === 0x0) {
      if (!s.fragment) {
        events.push(this.freezeAt('PROTOCOL_ERROR', '没有开放消息时出现 continuation 帧', frame));
        return events;
      }
    } else {
      if (s.fragment) {
        events.push(this.freezeAt('PROTOCOL_ERROR', '已有分片消息未结束时又出现新的数据首帧', frame));
        return events;
      }
      s.fragment = { opcode: frame.opcode as 1 | 2, chunks: [], totalSize: 0, frameCount: 0, startFrameIndex: frame.frameIndex };
    }

    const frag = s.fragment!;
    frag.chunks.push(payload.toString('base64'));
    frag.totalSize += payload.length;
    frag.frameCount += 1;
    if (frag.totalSize > s.limits.maxMessageSize) {
      events.push(this.freezeAt('LIMIT_EXCEEDED', `重组消息大小超过上限 ${s.limits.maxMessageSize}`, frame));
      return events;
    }

    if (frame.fin) {
      const full = Buffer.concat(frag.chunks.map((c) => Buffer.from(c, 'base64')));
      const msg: MessageEvent = {
        kind: 'message',
        messageIndex: s.messageIndex,
        type: frag.opcode === 1 ? 'text' : 'binary',
        frameCount: frag.frameCount,
        byteLength: full.length,
      };
      if (frag.opcode === 1) {
        const text = utf8StrictDecode(full);
        if (text === null) {
          events.push(this.freezeAt('PROTOCOL_ERROR', '文本消息整体重组后不是合法 UTF-8', frame));
          return events;
        }
        msg.text = text;
      } else {
        msg.payloadHex = full.toString('hex');
      }
      s.messageIndex += 1;
      s.fragment = null;
      events.push(msg);
    }
    return events;
  }
}
