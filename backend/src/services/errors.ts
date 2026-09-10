/**
 * RX Store — standardized API errors + request correlation.
 *
 * Every API response error uses one shape:
 *   { success: false, error: { code, message, requestId } }
 *
 * Internal details (DB errors, stack traces) are NEVER returned to clients —
 * they are logged server-side with the same requestId for correlation.
 */

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PAYMENTS_NOT_ENABLED'
  | 'MAINTENANCE'
  | 'DOWNLOAD_UNAVAILABLE'
  | 'INTERNAL';

/** Numeric HTTP status per code. */
const STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  PAYMENTS_NOT_ENABLED: 501,
  MAINTENANCE: 503,
  DOWNLOAD_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface ApiError {
  success: false;
  error: { code: ErrorCode; message: string; requestId?: string };
}

/** Generate a correlation id (request id). */
export function generateRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) return `req_${crypto.randomUUID()}`;
  } catch { /* fall through */ }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Extract a client-supplied request id (header) or generate one. */
export function requestIdFor(request: Request): string {
  const provided = request.headers.get('X-Request-Id') || request.headers.get('CF-Ray') || '';
  if (provided && /^[\w.:-]{1,128}$/.test(provided)) return provided;
  return generateRequestId();
}

/** Build the standardized error body. */
export function apiErrorBody(code: ErrorCode, message: string, requestId?: string): ApiError {
  return { success: false, error: { code, message, requestId } };
}

/** HTTP status for a code. */
export function statusForCode(code: ErrorCode): number {
  return STATUS[code] ?? 500;
}

/**
 * Map an internal thrown error to a SAFE client-facing error. The real message
 * is logged (with the requestId) but never returned — this prevents leaking
 * database/schema/runtime details.
 */
export function safeInternalError(requestId: string, log?: (msg: string) => void): ApiError {
  if (log) log(`[${requestId}] internal error`);
  return apiErrorBody('INTERNAL', 'Something went wrong. Please try again.', requestId);
}

/** Redact obvious secrets from a string before logging (defence in depth). */
export function redact(message: string): string {
  return String(message || '')
    .replace(/(bearer\s+)[\w.\-]+/gi, '$1[redacted]')
    .replace(/(sk-|nvapi-|AIza)[\w\-]{6,}/g, '[redacted-key]')
    // Quoted values: password: "hunter2"
    .replace(/("?(?:password|api[-_]?key|token|refreshToken|resetToken|secret)"?\s*[:=]\s*")([^"]*)(")/gi, '$1[redacted]$3')
    // Unquoted values: password: hunter2  /  token=abc123
    .replace(/("?(?:password|api[-_]?key|token|refreshToken|resetToken|secret)"?\s*[:=]\s*)([^\s,;&)\]]+)/gi, '$1[redacted]')
    .slice(0, 500);
}
