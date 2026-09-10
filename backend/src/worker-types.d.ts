/**
 * Minimal Cloudflare Workers ambient types.
 *
 * A @cloudflare/workers-types dependency is not installed (and adding it is a
 * build-wide change this hardening phase should not make), so we declare ONLY
 * the surfaces the code actually uses. These are structural stubs — they give
 * the type checker real shapes without pulling in the full runtime typings.
 */

/** A D1 (SQLite) prepared-statement binding. */
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = any>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: { changes?: number; last_row_id?: number } }>;
  all<T = any>(): Promise<{ results: T[]; success: boolean; meta?: unknown }>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<{ count: number; duration: number }>;
  batch<T = any>(statements: D1PreparedStatement[]): Promise<Array<{ results: T[] }>>;
}

/** An R2 object body handle. */
interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  etag: string;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
  head(key: string): Promise<{ size?: number; etag?: string } | null>;
  list(options?: unknown): Promise<{ objects: Array<{ key: string; size?: number }>; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string, options?: unknown): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): { uploadPart(n: number, data: unknown): Promise<{ partNumber: number; etag: string }>; complete(parts: unknown[]): Promise<unknown>; abort(): Promise<void> };
}

/** A Workers KV namespace. */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
