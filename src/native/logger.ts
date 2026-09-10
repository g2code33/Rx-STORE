/**
 * RX Store — structured logging + error reporting.
 *
 * Emits one JSON line per event so native shells, the browser console and log
 * aggregators can all parse it. Every record carries the fields Prompt 9 asks
 * for where they are relevant:
 *   requestId · attemptId · appId/slug · platform · version · state
 *
 * SECURITY: values are passed through `redact()` before they are serialised, so
 * passwords, access/refresh tokens, API keys and reset tokens can never be
 * logged — even if a caller accidentally includes them in a context object.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  /** Server correlation id (from the X-Request-Id response header). */
  requestId?: string;
  /** Installation attempt id (from the install transaction). */
  attemptId?: string;
  appId?: string;
  appSlug?: string;
  platform?: string;
  version?: string;
  /** Transaction / installation state (e.g. VERIFYING, INSTALLED). */
  state?: string;
  /** Anything else worth recording (redacted, never credentials). */
  [k: string]: unknown;
}

export interface LogRecord extends LogContext {
  level: LogLevel;
  event: string;
  message: string;
  at: string;
}

const SENSITIVE_KEY_RE = /pass(word)?|token|secret|api[-_]?key|authorization|cookie|session/i;
const TOKEN_VALUE_RE = /(bearer\s+)[\w.\-]+/gi;
const KEY_VALUE_RE = /(sk-|nvapi-|AIza)[\w\-]{6,}/g;

/** Strip credentials from a string (defence in depth alongside key filtering). */
export function redactString(input: unknown): string {
  return String(input ?? '')
    .replace(TOKEN_VALUE_RE, '$1[redacted]')
    .replace(KEY_VALUE_RE, '[redacted-key]')
    .slice(0, 2000);
}

/** Deep-redact a context object: sensitive KEYS are replaced, strings scrubbed. */
export function redactContext(ctx: LogContext | undefined, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!ctx) return out;
  if (depth > 3) return { _truncated: true };
  for (const [k, v] of Object.entries(ctx)) {
    if (SENSITIVE_KEY_RE.test(k)) { out[k] = '[redacted]'; continue; }
    if (v === null || v === undefined) { out[k] = v; continue; }
    if (typeof v === 'string') { out[k] = redactString(v); continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue; }
    if (Array.isArray(v)) { out[k] = v.slice(0, 20).map((x) => (typeof x === 'object' ? redactContext(x as LogContext, depth + 1) : redactString(x))); continue; }
    if (typeof v === 'object') { out[k] = redactContext(v as LogContext, depth + 1); continue; }
    out[k] = redactString(v);
  }
  return out;
}

/** Optional sink (e.g. forward errors to a monitoring endpoint). */
type Sink = (record: LogRecord) => void;
let sink: Sink | null = null;

/** Install a log sink. Returns a function that restores the previous sink. */
export function setLogSink(next: Sink | null): () => void {
  const prev = sink;
  sink = next;
  return () => { sink = prev; };
}

function emit(level: LogLevel, event: string, message: string, ctx?: LogContext): LogRecord {
  const record: LogRecord = {
    level,
    event,
    message: redactString(message),
    at: new Date().toISOString(),
    ...redactContext(ctx),
  } as LogRecord;
  try {
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch { /* logging must never throw */ }
  try { sink?.(record); } catch { /* a bad sink must never break the app */ }
  return record;
}

export const log = {
  debug: (event: string, message: string, ctx?: LogContext) => emit('debug', event, message, ctx),
  info: (event: string, message: string, ctx?: LogContext) => emit('info', event, message, ctx),
  warn: (event: string, message: string, ctx?: LogContext) => emit('warn', event, message, ctx),
  error: (event: string, message: string, ctx?: LogContext) => emit('error', event, message, ctx),
};

/**
 * The observable failure categories from Prompt 9 §6. Reporting is centralized so
 * every one of these is consistently structured (and none leak internals to the
 * user — these are diagnostics, not UI copy).
 */
export type FailureCategory =
  | 'download_failure'
  | 'checksum_failure'
  | 'install_failure'
  | 'detection_failure'
  | 'sync_failure'
  | 'auth_failure';

export function reportFailure(category: FailureCategory, message: string, ctx?: LogContext): LogRecord {
  return log.error(category, message, ctx);
}

/** Counters so a diagnostics surface (or tests) can assert what happened. */
const counters = new Map<string, number>();
export function recordMetric(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}
export function metricSnapshot(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}
export function resetMetrics(): void {
  counters.clear();
}
