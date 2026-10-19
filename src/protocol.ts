export type ErrorCode = 'usage' | 'not-found' | 'refused' | 'backend' | 'unsupported'

export type Reply =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; code: ErrorCode; message: string }

export const exitCodes: Record<ErrorCode, number> = {
  usage: 2,
  'not-found': 3,
  refused: 4,
  backend: 5,
  unsupported: 6,
}

export class RequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}
