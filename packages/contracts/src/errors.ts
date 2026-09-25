import type { Problem } from './schema';

/** Error thrown for every non-2xx response, carrying the RFC 7807 body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;

  constructor(status: number, problem: Partial<Problem> | null, fallbackMessage?: string) {
    const p: Problem = { status, ...(problem ?? {}) } as Problem;
    const detailText = typeof p.detail === 'string' ? p.detail : undefined;
    super(detailText || p.title || fallbackMessage || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = p.code ?? codeFromStatus(status);
    this.problem = p;
  }

  /** 422 field errors, `{field: message}`. */
  get fieldErrors(): Record<string, string> {
    return this.problem.errors ?? {};
  }

  /** 401 PIN_INVALID → attempts left before lock. */
  get attemptsLeft(): number | null {
    const v = this.problem.attempts_left;
    return typeof v === 'number' ? v : null;
  }

  /** 423 PIN_LOCKED → ISO time until which PIN entry is locked. */
  get lockedUntil(): string | null {
    const p = this.problem;
    if (typeof p.locked_until === 'string') return p.locked_until;
    if (p.detail && typeof p.detail === 'object' && typeof p.detail.locked_until === 'string') {
      return p.detail.locked_until;
    }
    if (typeof p.detail === 'string') {
      const m = /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/.exec(p.detail);
      if (m) return m[0];
    }
    return null;
  }
}

/** Raised when the user closes the PIN dialog instead of entering a PIN. */
export class PinCancelledError extends ApiError {
  constructor() {
    super(423, { code: 'PIN_REQUIRED', title: 'Cần nhập mã PIN để tiếp tục' });
    this.name = 'PinCancelledError';
  }
}

function codeFromStatus(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'VALIDATION_ERROR';
    case 423:
      return 'PIN_REQUIRED';
    case 428:
      return 'SETUP_REQUIRED';
    default:
      return status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
