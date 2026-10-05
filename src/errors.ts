export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'SEQ_CONFLICT'
  | 'STREAM_CLOSED'
  | 'STREAM_FROZEN'
  | 'LIMIT_EXCEEDED'
  | 'PROTOCOL_ERROR'
  | 'ENCODING_ERROR';

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
