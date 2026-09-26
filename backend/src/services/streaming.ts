/**
 * Streaming primitives for large R2 objects (production security pipeline).
 *
 * Design constraints:
 *   - NEVER buffer an entire large package into Worker memory. An 86 MB DEB
 *     (or bigger) must be hashed and uploaded to the scanner chunk-by-chunk.
 *   - Production (Cloudflare Workers): `crypto.DigestStream("SHA-256")` is
 *     piped from the R2 `ReadableStream` — zero full-object buffering.
 *   - Tests (Node runtime): no DigestStream — fall back to `node:crypto`
 *     createHash with chunked reads (identical results, still streaming).
 *   - The multipart encoder streams `prefix + R2 body + suffix` with a known
 *     total Content-Length (R2 reports object sizes), so the scanner receives
 *     the exact object bytes without any client-side buffering.
 */

const CHUNK = 4 * 1024 * 1024; // 4 MB read chunks — bounded memory in every path

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Incremental SHA-256 over a ReadableStream of Uint8Array chunks. */
export async function sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  // Workers runtime path: pipe into DigestStream.
  const DS = (globalThis as any).crypto?.DigestStream;
  if (typeof DS === 'function') {
    const ds = new DS('SHA-256');
    await stream.pipeTo(ds as unknown as WritableStream<Uint8Array>);
    return hex(new Uint8Array(ds.digest as ArrayBuffer));
  }
  // Node/test path: node:crypto createHash (streaming, chunked).
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest('hex');
}

/** Read a stream chunk-by-chunk, invoking `onChunk` for each — never buffers the whole body. */
export async function forEachChunk(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => Promise<void> | void): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) await onChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamedHash {
  size: number;
  sha256: string;
}

/**
 * Stream-hash an R2 object: SHA-256 + actual byte count of EXACTLY what is
 * stored, without `arrayBuffer()` on the whole object. Returns null when the
 * object cannot be read (missing key, storage error, empty body).
 */
export async function sha256R2Object(env: any, storageKey: string): Promise<StreamedHash | null> {
  try {
    const obj: any = await env?.STORAGE?.get(String(storageKey || ''));
    if (!obj || typeof obj.body?.getReader !== 'function') return null;
    const sha256 = await sha256OfStream(obj.body as ReadableStream<Uint8Array>);
    return { size: Number(obj.size ?? 0) || 0, sha256 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Streaming multipart/form-data encoder (file upload from an R2 stream)
// ---------------------------------------------------------------------------

export interface StreamingMultipart {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  /** Exact total length (prefix + file bytes + suffix) — known because R2 reports sizes. */
  contentLength: number;
}

/**
 * Build a multipart/form-data body that streams an R2 object to a scanner
 * upload endpoint WITHOUT materialising the file: a short binary prefix
 * (boundary + file part headers), the R2 `ReadableStream`, then the closing
 * boundary — all exposed as one ReadableStream with an exact Content-Length.
 * The scanner receives the exact stored bytes, unmodified.
 */
export function streamToMultipart(
  fileStream: ReadableStream<Uint8Array>,
  input: { filename: string; fileSize: number; contentType?: string; field?: string },
): StreamingMultipart {
  const boundary = `----rxstore${crypto.randomUUID().replace(/-/g, '')}`;
  const field = input.field || 'file';
  const safeType = input.contentType || 'application/octet-stream';
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${input.filename.replace(/["\\]/g, '')}"\r\n` +
    `Content-Type: ${safeType}\r\n` +
    `\r\n`
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const contentLength = prefix.length + input.fileSize + suffix.length;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(prefix);
      try {
        const reader = fileStream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) controller.enqueue(value as unknown as Uint8Array);
          }
        } finally {
          reader.releaseLock();
        }
        controller.enqueue(suffix);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return { body, contentType: `multipart/form-data; boundary=${boundary}`, contentLength };
}

export { CHUNK };
