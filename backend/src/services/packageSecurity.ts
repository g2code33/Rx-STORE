/**
 * Package Security & Verification pipeline (Phase 13).
 *
 * HONESTY CONTRACT (mirrors the phase spec):
 *   - A package is NEVER marked safe because an upload succeeded.
 *   - Every check parses the REAL bytes from storage (PE / ZIP-APK / ar-deb /
 *     ELF / DER structures). Filenames, extensions, MIME types and frontend
 *     metadata are never trusted as evidence.
 *   - The malware scanner is a REAL pluggable provider (VirusTotal hash lookup
 *     or a custom REST scanner). With no scanner configured the result is
 *     UNAVAILABLE and publication stays BLOCKED — never "clean".
 *   - Signature checks distinguish "signed" from "verified": where full chain
 *     validation is not possible in the Worker runtime the result says so
 *     (NEEDS_REVIEW), it does not pretend.
 *   - The only bypass is an admin override with an explicit reason, admin
 *     identity, timestamp and audit record.
 *
 * State machine (packages.security_state) — stages can never be skipped:
 *   QUARANTINED -> STRUCTURE_CHECK -> INTEGRITY_CHECK -> DUPLICATE_CHECK ->
 *   MALWARE_SCAN -> SIGNATURE_CHECK -> CERTIFICATE_CHECK ->
 *   DEPENDENCY_SECURITY_CHECK -> NATIVE_IDENTITY_CHECK ->
 *   SECURITY_REVIEW_COMPLETE -> PUBLISHED   (SECURITY_OVERRIDE = admin bypass)
 */

// ---------------------------------------------------------------------------
// Types + status vocabularies
// ---------------------------------------------------------------------------

export const PIPELINE_STAGES = [
  'QUARANTINED', 'STRUCTURE_CHECK', 'INTEGRITY_CHECK', 'DUPLICATE_CHECK', 'MALWARE_SCAN',
  'SIGNATURE_CHECK', 'CERTIFICATE_CHECK', 'DEPENDENCY_SECURITY_CHECK', 'NATIVE_IDENTITY_CHECK',
  'SECURITY_REVIEW_COMPLETE', 'PUBLISHED',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const CHECK_ORDER = [
  'structure', 'integrity', 'duplicate', 'malware', 'signature', 'certificate', 'dependency', 'native_identity',
] as const;
export type CheckType = (typeof CHECK_ORDER)[number];

/** Malware scan statuses (spec §5). */
export type MalwareStatus = 'PENDING' | 'SCANNING' | 'CLEAN' | 'DETECTED' | 'FAILED' | 'UNAVAILABLE';
/** Generic check statuses (spec §8). */
export type CheckStatus = 'PASSED' | 'FAILED' | 'WARNING' | 'NEEDS_REVIEW' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | 'CLEAN' | 'DETECTED' | 'SCANNING' | 'PENDING';

export interface CheckResult {
  status: CheckStatus;
  result: string;
  details?: string;
  classification?: string;
  provider?: string;
  providerVersion?: string;
  fingerprint?: string;
  error?: string;
}

export function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data.slice().buffer as ArrayBuffer : data;
  const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', buf);
  return hex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Package bytes access (head/tail windows; full buffer for small packages)
// ---------------------------------------------------------------------------

const FULL_INSPECT_LIMIT = 64 * 1024 * 1024; // ≤64MB: read whole object once
const WINDOW = 2 * 1024 * 1024;              // >64MB: first+last 2MB windows

export interface PackageBytes {
  size: number;
  head: Uint8Array;
  headOffset: number; // always 0
  tail: Uint8Array;
  tailOffset: number; // size - tail.length
  /** Full bytes when the whole object was buffered (≤64MB). */
  full: Uint8Array | null;
}

export async function loadPackageBytes(env: any, storageKey: string): Promise<PackageBytes | null> {
  try {
    const headObj: any = await env.STORAGE.get(storageKey, { range: { offset: 0, length: WINDOW + 1 } });
    if (!headObj) return null;
    const head = new Uint8Array(await headObj.arrayBuffer());
    const size = Number(headObj.size ?? 0) || head.length;
    if (size <= FULL_INSPECT_LIMIT && head.length >= size) {
      return { size, head, headOffset: 0, tail: head, tailOffset: 0, full: head };
    }
    // Large object: also read the tail window (EOCD / signing blocks live there).
    const tailLen = Math.min(WINDOW, Math.max(0, size - 1));
    const tailObj: any = await env.STORAGE.get(storageKey, { range: { offset: Math.max(0, size - tailLen), length: tailLen } });
    const tail = tailObj ? new Uint8Array(await tailObj.arrayBuffer()) : new Uint8Array(0);
    return { size, head, headOffset: 0, tail, tailOffset: size - tail.length, full: null };
  } catch {
    return null;
  }
}

/** Read [offset, offset+length) if it falls inside a loaded window. */
function sliceBytes(pb: PackageBytes, offset: number, length: number): Uint8Array | null {
  if (pb.full) {
    if (offset < 0 || offset + length > pb.full.length) return null;
    return pb.full.subarray(offset, offset + length);
  }
  if (offset >= pb.headOffset && offset + length <= pb.headOffset + pb.head.length) {
    return pb.head.subarray(offset - pb.headOffset, offset - pb.headOffset + length);
  }
  if (offset >= pb.tailOffset && offset + length <= pb.tailOffset + pb.tail.length) {
    return pb.tail.subarray(offset - pb.tailOffset, offset - pb.tailOffset + length);
  }
  return null;
}

function u16(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number): number { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

// ---------------------------------------------------------------------------
// Binary structure parsers (pure, unit-tested)
// ---------------------------------------------------------------------------

export interface PeInfo { machine: number; machineName: string; hasSecurityDir: boolean; certOffset: number; certSize: number; }

/** Parse the PE (Windows .exe) headers. Returns null when not a PE. */
export function parsePe(pb: PackageBytes): PeInfo | null {
  const h = pb.head;
  if (h.length < 0x40 || h[0] !== 0x4d || h[1] !== 0x5a) return null; // "MZ"
  const peOff = u32(h, 0x3c);
  const pe = sliceBytes(pb, peOff, 264);
  if (!pe || pe.length < 24 || pe[0] !== 0x50 || pe[1] !== 0x45 || pe[2] !== 0 || pe[3] !== 0) return null; // "PE\0\0"
  const machine = u16(pe, 4);
  const machines: Record<number, string> = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64', 0x1c0: 'arm', 0x1c4: 'armnt' };
  const optMagic = u16(pe, 24);
  let dirBase = -1;
  if (optMagic === 0x20b) dirBase = peOff + 24 + 112;      // PE32+ data directories
  else if (optMagic === 0x10b) dirBase = peOff + 24 + 96;  // PE32
  let hasSecurityDir = false, certOffset = 0, certSize = 0;
  if (dirBase > 0) {
    const dirs = sliceBytes(pb, dirBase, 8 * 4); // first 4 entries include #4? no: entries 0..3
    // Security directory is index 4 → need 5 entries (40 bytes).
    const dirs5 = sliceBytes(pb, dirBase, 40);
    const d = dirs5 || dirs;
    if (d && d.length >= 40) {
      certSize = u32(d, 4 * 8 + 4);
      certOffset = u32(d, 4 * 8);
      hasSecurityDir = certSize > 0 && certOffset > 0 && certOffset + certSize <= pb.size;
    }
  }
  return { machine, machineName: machines[machine] || `unknown_0x${machine.toString(16)}`, hasSecurityDir, certOffset, certSize };
}

export interface ZipEntry { name: string; method: number; offset: number; compressedSize: number; uncompressedSize: number; }

/** Parse the ZIP central directory (validates real ZIP/APK/AAB structure). */
export function parseZipCentralDirectory(pb: PackageBytes): ZipEntry[] | null {
  const t = pb.tail;
  if (t.length < 22) return null;
  let eocd = -1;
  const stop = Math.max(0, t.length - 22 - 65535);
  for (let i = t.length - 22; i >= stop; i--) {
    if (t[i] === 0x50 && t[i + 1] === 0x4b && t[i + 2] === 0x05 && t[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entryCount = u16(t, eocd + 10);
  let cdOffset = u32(t, eocd + 16);
  const cdSize = u32(t, eocd + 12);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null; // ZIP64 not needed for our sizes
  const cd = sliceBytes(pb, cdOffset, Math.min(cdSize, 4 * 1024 * 1024));
  if (!cd) return null;
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < entryCount && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) return entries.length ? entries : null; // corrupt CD
    const method = u16(cd, p + 10);
    const compSize = u32(cd, p + 20);
    const uncompSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const offset = u32(cd, p + 42);
    const name = new TextDecoder('utf-8', { fatal: false }).decode(cd.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, offset, compressedSize: compSize, uncompressedSize: uncompSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract a ZIP entry's bytes (STORED directly; DEFLATE via DecompressionStream). */
export async function extractZipEntry(pb: PackageBytes, entry: ZipEntry): Promise<Uint8Array | null> {
  const lh = sliceBytes(pb, entry.offset, 30);
  if (!lh || u32(lh, 0) !== 0x04034b50) return null;
  const nameLen = u16(lh, 26);
  const extraLen = u16(lh, 28);
  const dataOffset = entry.offset + 30 + nameLen + extraLen;
  if (entry.method === 0) {
    return sliceBytes(pb, dataOffset, entry.compressedSize);
  }
  if (entry.method === 8) {
    const raw = sliceBytes(pb, dataOffset, entry.compressedSize);
    if (!raw) return null;
    try {
      const ds = new DecompressionStream('deflate-raw' as any);
      const stream = new Blob([raw.slice() as unknown as BlobPart]).stream().pipeThrough(ds);
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

/** Is an APK Signing Block (v2/v3) present immediately before the CD? */
export function hasApkSigningBlock(pb: PackageBytes, entries: ZipEntry[]): boolean {
  if (!entries.length) return false;
  // The signing block sits immediately BEFORE the central directory — its
  // offset comes from the EOCD (not from the local entry offsets).
  const t = pb.tail;
  let eocd = -1;
  const stop = Math.max(0, t.length - 22 - 65535);
  for (let i = t.length - 22; i >= stop; i--) {
    if (t[i] === 0x50 && t[i + 1] === 0x4b && t[i + 2] === 0x05 && t[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return false;
  const cdOffset = u32(t, eocd + 16);
  if (cdOffset === 0xffffffff) return false;
  const magic = sliceBytes(pb, cdOffset - 16, 16);
  if (!magic) return false;
  const s = new TextDecoder('latin1').decode(magic);
  return s === 'APK Sig Block 42';
}

export interface ArMember { name: string; offset: number; size: number; }

/** Parse an `ar` archive (.deb packages are ar archives). */
export function parseAr(pb: PackageBytes): ArMember[] | null {
  const h = pb.head;
  const magic = '!<arch>\n';
  for (let i = 0; i < 8; i++) if (h[i] !== magic.charCodeAt(i)) return null;
  const members: ArMember[] = [];
  let p = 8;
  while (p + 60 <= h.length) {
    const name = new TextDecoder('latin1').decode(h.subarray(p, p + 16)).trim().replace(/\/$/, '');
    const sizeStr = new TextDecoder('latin1').decode(h.subarray(p + 48, p + 58)).trim();
    const size = parseInt(sizeStr, 10);
    if (!Number.isFinite(size)) break;
    members.push({ name, offset: p + 60, size });
    p += 60 + size + (size % 2); // members are 2-byte aligned
    if (members.length > 32) break;
  }
  return members;
}

/** Decompress gzip bytes (control.tar.gz inside .deb). */
export async function gunzip(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([data.slice() as unknown as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Read `Package:` from a control.tar.{gz,xz} ar member of a .deb. */
export async function readDebPackageName(pb: PackageBytes, members: ArMember[]): Promise<{ name: string | null; reason?: string }> {
  const control = members.find((m) => /^control\.tar\.(gz|xz|zst)?$/.test(m.name) || m.name === 'control.tar');
  if (!control) return { name: null, reason: 'no control.tar member found in the .deb archive' };
  if (!/\.gz$/.test(control.name)) return { name: null, reason: `unsupported control compression '${control.name}' (only gzip is verifiable in this pipeline)` };
  const bytes = sliceBytes(pb, control.offset, control.size);
  if (!bytes) return { name: null, reason: 'control.tar.gz outside the inspectable byte window' };
  const tar = await gunzip(bytes);
  if (!tar) return { name: null, reason: 'control.tar.gz could not be decompressed' };
  // Minimal tar walk for ./control (512-byte headers).
  let p = 0;
  while (p + 512 <= tar.length) {
    const name = new TextDecoder('latin1').decode(tar.subarray(p, p + 100)).replace(/\0.*$/, '');
    const sizeStr = new TextDecoder('latin1').decode(tar.subarray(p + 124, p + 136)).trim();
    const size = parseInt(sizeStr, 8);
    if (!Number.isFinite(size)) break;
    const base = name.replace(/^\.\//, '');
    if (base === 'control' || base === './control') {
      const body = new TextDecoder('latin1').decode(tar.subarray(p + 512, p + 512 + size));
      const m = body.match(/^Package:\s*(\S+)/mi);
      if (m) return { name: m[1] };
      return { name: null, reason: 'control file has no Package: field' };
    }
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return { name: null, reason: 'control member not found inside control.tar.gz' };
}

// ---------------------------------------------------------------------------
// Minimal DER walker (PKCS#7 → X.509 certificate extraction + validity)
// ---------------------------------------------------------------------------

export interface DerNode { tag: number; start: number; end: number; children: DerNode[]; }

export function parseDer(buf: Uint8Array, start = 0, end = buf.length): DerNode | null {
  if (start >= end) return null;
  const tag = buf[start];
  let p = start + 1;
  let len = 0;
  const first = buf[p];
  if (first < 0x80) { len = first; p += 1; }
  else {
    const n = first & 0x7f;
    if (n === 0 || n > 4 || p + n > end) return null;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p + 1 + i];
    p += 1 + n;
  }
  const nodeEnd = p + len;
  if (nodeEnd > end) return null;
  const constructed = (tag & 0x20) !== 0;
  const children: DerNode[] = [];
  if (constructed) {
    let c = p;
    while (c < nodeEnd) {
      const child = parseDer(buf, c, nodeEnd);
      if (!child) break;
      children.push(child);
      c = child.end;
    }
  }
  return { tag, start, end: nodeEnd, children };
}

/** Extract the first X.509 certificate DER from a PKCS#7 SignedData blob. */
export function extractCertificateFromPkcs7(pkcs7: Uint8Array): Uint8Array | null {
  const root = parseDer(pkcs7);
  if (!root || root.tag !== 0x30 || root.children.length < 2) return null;
  const contentInfo = root.children[1]; // [0] EXPLICIT SignedData
  const signedData = contentInfo.children[0];
  if (!signedData) return null;
  // children: version, digestAlgorithms, contentInfo, [0] certificates, ...
  const certs = signedData.children.find((c) => c.tag === 0xa0);
  if (!certs || !certs.children.length) return null;
  const cert = certs.children[0];
  if (cert.tag !== 0x30) return null;
  return pkcs7.subarray(cert.start, cert.end);
}

export interface CertInfo { fingerprintSha256: string; notBefore: Date | null; notAfter: Date | null; }

/** Parse validity dates + fingerprint from an X.509 certificate DER. */
export function parseCertificate(cert: Uint8Array): CertInfo | null {
  const root = parseDer(cert);
  if (!root || root.tag !== 0x30 || !root.children.length) return null;
  const tbs = root.children[0];
  if (tbs.tag !== 0x30) return null;
  // tbs children: [0] version?, serial, sigAlg, issuer, validity, subject, ...
  const validity = tbs.children.find((c, i) => {
    void i;
    return c.tag === 0x30 && c.children.length >= 2 &&
      (c.children[0].tag === 0x17 || c.children[0].tag === 0x18) &&
      (c.children[1].tag === 0x17 || c.children[1].tag === 0x18);
  });
  const parseTime = (node: DerNode | undefined): Date | null => {
    if (!node) return null;
    const s = new TextDecoder('latin1').decode(cert.subarray(node.start + 2, node.end));
    // UTCTime (0x17): YYMMDDHHMMSSZ — 2-digit year. GeneralizedTime (0x18): YYYYMMDDHHMMSSZ.
    const utcm = node.tag === 0x17 ? s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z?/) : null;
    if (utcm) {
      const yy = parseInt(utcm[1], 10);
      return new Date(Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, parseInt(utcm[2], 10) - 1, parseInt(utcm[3], 10), parseInt(utcm[4], 10), parseInt(utcm[5], 10), parseInt(utcm[6] || '0', 10)));
    }
    const gtm = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z?/);
    if (!gtm) return null;
    return new Date(Date.UTC(parseInt(gtm[1], 10), parseInt(gtm[2], 10) - 1, parseInt(gtm[3], 10), parseInt(gtm[4], 10), parseInt(gtm[5], 10), parseInt(gtm[6] || '0', 10)));
  };
  return {
    fingerprintSha256: '', // filled by the async caller
    notBefore: validity ? parseTime(validity.children[0]) : null,
    notAfter: validity ? parseTime(validity.children[1]) : null,
  };
}

export async function certificateInfo(cert: Uint8Array): Promise<CertInfo | null> {
  const info = parseCertificate(cert);
  if (!info) return null;
  info.fingerprintSha256 = await sha256Hex(cert);
  return info;
}

// ---------------------------------------------------------------------------
// CHECK 1 — structure (real content vs platform/format expectations)
// ---------------------------------------------------------------------------

export async function checkStructure(input: {
  platform: string; architecture: string; filename: string; bytes: PackageBytes;
}): Promise<CheckResult> {
  const { platform, architecture, filename, bytes } = input;
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (platform === 'windows') {
    if (ext === 'msi') {
      // MSI = OLE Compound File.
      const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
      if (bytes.head.length >= 8 && magic.every((b, i) => bytes.head[i] === b)) {
        return { status: 'PASSED', result: 'MSI compound-document structure valid' };
      }
      return { status: 'FAILED', result: 'not a valid MSI', details: 'The file does not start with the OLE compound-document signature — it is not a real Windows Installer package.' };
    }
    const pe = parsePe(bytes);
    if (!pe) return { status: 'FAILED', result: 'not a valid PE executable', details: 'The file does not contain valid MZ/PE headers — it is not a real Windows executable.' };
    if (architecture !== 'universal' && pe.machineName !== architecture) {
      return { status: 'FAILED', result: `architecture mismatch`, details: `The PE machine type is ${pe.machineName} but the package was uploaded as ${architecture}.` };
    }
    return { status: 'PASSED', result: `valid PE executable (${pe.machineName})` };
  }

  if (platform === 'android') {
    if (!['apk', 'aab'].includes(ext)) {
      return { status: 'FAILED', result: `unexpected extension .${ext}`, details: 'Android packages must be .apk or .aab.' };
    }
    if (bytes.head.length < 4 || bytes.head[0] !== 0x50 || bytes.head[1] !== 0x4b) {
      return { status: 'FAILED', result: 'not a ZIP-based package', details: 'APK/AAB files are ZIP archives; this file does not start with the ZIP signature.' };
    }
    const entries = parseZipCentralDirectory(bytes);
    if (!entries || !entries.length) {
      return { status: 'FAILED', result: 'invalid ZIP structure', details: 'The ZIP central directory could not be parsed — the archive is malformed or truncated.' };
    }
    const hasManifest = entries.some((e) => e.name === 'AndroidManifest.xml');
    if (!hasManifest) {
      return { status: 'FAILED', result: 'AndroidManifest.xml missing', details: 'The archive does not contain AndroidManifest.xml — it is not a valid Android package.' };
    }
    return { status: 'PASSED', result: `valid Android package (${entries.length} entries)` };
  }

  if (platform === 'linux_deb') {
    const members = parseAr(bytes);
    if (!members) return { status: 'FAILED', result: 'not a valid .deb archive', details: 'Debian packages are ar archives; this file does not have the ar signature.' };
    if (!members.some((m) => m.name === 'debian-binary')) {
      return { status: 'FAILED', result: 'debian-binary member missing', details: 'The ar archive lacks the debian-binary member required for .deb packages.' };
    }
    if (!members.some((m) => /^control\.tar/.test(m.name)) || !members.some((m) => /^data\.tar/.test(m.name))) {
      return { status: 'FAILED', result: 'incomplete .deb structure', details: 'The archive lacks the control.tar/data.tar members of a Debian package.' };
    }
    return { status: 'PASSED', result: 'valid .deb structure' };
  }

  if (platform === 'linux_appimage') {
    if (bytes.head.length >= 4 && bytes.head[0] === 0x7f && bytes.head[1] === 0x45 && bytes.head[2] === 0x4c && bytes.head[3] === 0x46) {
      return { status: 'PASSED', result: 'valid ELF executable (AppImage)' };
    }
    return { status: 'FAILED', result: 'not an ELF executable', details: 'AppImages must start with the ELF magic bytes.' };
  }

  if (platform === 'web' || platform === 'pwa') {
    // URL-based platforms have no downloadable binary to validate.
    return { status: 'NOT_APPLICABLE', result: 'URL-based platform (no binary)' };
  }

  return { status: 'NOT_APPLICABLE', result: `no structure rule for platform ${platform}` };
}

// ---------------------------------------------------------------------------
// CHECK 3 — duplicate detection (SHA-256 classification)
// ---------------------------------------------------------------------------

export function classifyDuplicate(input: {
  sameShaElsewhere: Array<{ id: string; appId: string; releaseVersion?: string; platform: string; appName?: string }>;
  currentAppId: string; currentReleaseId: string; currentPlatform: string; currentArch: string;
  sameSlotOtherId?: { id: string; version?: string } | null;
}): CheckResult {
  const { sameShaElsewhere, currentAppId } = input;
  // Same hash in the SAME slot would have been upserted onto this row — a
  // remaining row with the same hash in another slot is the interesting case.
  const sameApp = sameShaElsewhere.filter((r) => r.appId === currentAppId);
  const otherApp = sameShaElsewhere.filter((r) => r.appId !== currentAppId);
  if (otherApp.length) {
    return {
      status: 'WARNING', classification: 'REPLACEMENT_CONFLICT',
      result: 'this exact binary is already stored under another application',
      details: `SHA-256 already exists for: ${otherApp.map((r) => `${r.appName || r.appId} (${r.platform})`).join(', ')}. Confirm this reuse is intentional.`,
    };
  }
  if (sameApp.length) {
    return {
      status: 'WARNING', classification: 'REPLACEMENT_CONFLICT',
      result: 'this exact binary is already stored for another release of this app',
      details: `SHA-256 already exists in: ${sameApp.map((r) => `${r.releaseVersion || r.id} (${r.platform})`).join(', ')}. Identical binaries across releases are usually a mistake.`,
    };
  }
  return { status: 'PASSED', classification: 'NEW_PACKAGE', result: 'no other package shares this SHA-256' };
}

// ---------------------------------------------------------------------------
// CHECK 4 — malware scan (pluggable providers, fail-closed)
// ---------------------------------------------------------------------------

const SCAN_TIMEOUT_MS = 15000;

/** Resolve the scanner provider config from env. */
export function scannerProvider(env: any): { kind: 'virustotal' | 'custom' } | null {
  const kind = String(env?.MALWARE_SCANNER || '').toLowerCase();
  if (kind === 'virustotal' && env?.VIRUSTOTAL_API_KEY) return { kind: 'virustotal' };
  if (kind === 'custom' && env?.MALWARE_SCANNER_URL) return { kind: 'custom' };
  return null;
}

export async function runMalwareScan(env: any, input: {
  sha256: string; filename: string; size: number; platform: string;
}): Promise<CheckResult> {
  const provider = scannerProvider(env);
  if (!provider) {
    const key = String(env?.MALWARE_SCANNER || '');
    return {
      status: 'UNAVAILABLE',
      result: 'no malware scanner configured',
      details: `Malware scanning is not configured (MALWARE_SCANNER=${JSON.stringify(key)}). The package stays blocked from publication until a scanner is configured (MALWARE_SCANNER=virustotal + VIRUSTOTAL_API_KEY, or MALWARE_SCANNER=custom + MALWARE_SCANNER_URL) or an admin explicitly overrides with a reason.`,
    };
  }
  try {
    if (provider.kind === 'virustotal') {
      const res = await fetch(`https://www.virustotal.com/api/v3/files/${input.sha256}`, {
        headers: { 'x-apikey': String(env.VIRUSTOTAL_API_KEY) },
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
      });
      if (res.status === 404) {
        return { status: 'FAILED', provider: 'virustotal', result: 'hash unknown to VirusTotal', details: 'The file hash has never been scanned by VirusTotal, so it cannot be cleared by lookup. Configure an upload-capable custom scanner (MALWARE_SCANNER=custom) or override explicitly after manual review.' };
      }
      if (!res.ok) {
        return { status: 'FAILED', provider: 'virustotal', result: `scanner responded ${res.status}`, error: `HTTP ${res.status}` };
      }
      const j: any = await res.json();
      const stats = j?.data?.attributes?.last_analysis_stats || {};
      const malicious = Number(stats.malicious || 0) + Number(stats.suspicious || 0);
      if (malicious > 0) {
        return { status: 'DETECTED', provider: 'virustotal', result: `${malicious} engine detection(s)`, details: `malicious=${stats.malicious} suspicious=${stats.suspicious}` };
      }
      return { status: 'CLEAN', provider: 'virustotal', providerVersion: 'api-v3', result: 'no engine detections', details: `harmless=${stats.harmless || 0} undetected=${stats.undetected || 0}` };
    }
    // custom REST scanner
    const res = await fetch(String(env.MALWARE_SCANNER_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.MALWARE_SCANNER_KEY ? { Authorization: `Bearer ${env.MALWARE_SCANNER_KEY}` } : {}),
      },
      body: JSON.stringify({ sha256: input.sha256, filename: input.filename, size: input.size, platform: input.platform }),
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'FAILED', provider: 'custom', result: `scanner responded ${res.status}`, error: `HTTP ${res.status}` };
    const j: any = await res.json();
    const status = String(j?.status || '').toUpperCase();
    if (status === 'CLEAN') return { status: 'CLEAN', provider: j?.provider || 'custom', providerVersion: j?.version, result: j?.result || 'no detections', details: j?.details };
    if (status === 'DETECTED') return { status: 'DETECTED', provider: j?.provider || 'custom', providerVersion: j?.version, result: j?.result || 'detections reported', details: j?.details || JSON.stringify(j?.detections || '').slice(0, 300) };
    if (status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', provider: j?.provider || 'custom', result: j?.result || 'scanner unavailable', details: j?.details };
    return { status: 'FAILED', provider: j?.provider || 'custom', result: `unrecognized scanner status '${status}'` };
  } catch (e: any) {
    return { status: 'FAILED', provider: provider.kind, result: 'scanner request failed', error: String(e?.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// CHECK 5/6 — signature + certificate (platform-aware)
// ---------------------------------------------------------------------------

export interface SignatureOutcome extends CheckResult { pkcs7?: Uint8Array | null; }

export async function checkSignature(input: {
  platform: string; bytes: PackageBytes; entries: ZipEntry[] | null;
}): Promise<SignatureOutcome> {
  const { platform, bytes, entries } = input;

  if (platform === 'windows') {
    const pe = parsePe(bytes);
    if (!pe) return { status: 'NEEDS_REVIEW', result: 'not a PE — cannot verify' };
    if (!pe.hasSecurityDir) {
      return { status: 'WARNING', result: 'unsigned executable', details: 'This Windows executable has no Authenticode signature. RX Store can still distribute it, but users see browser/SmartScreen warnings. Consider signing it.' };
    }
    const certBlob = sliceBytes(bytes, pe.certOffset, Math.min(pe.certSize, 4 * 1024 * 1024));
    if (!certBlob) return { status: 'NEEDS_REVIEW', result: 'certificate table outside the inspectable window' };
    if (certBlob[0] !== 0x30) {
      return { status: 'NEEDS_REVIEW', result: 'Authenticode blob is not a DER structure' };
    }
    // Present + structurally valid. Full chain validation is not possible in
    // the Worker runtime — say so honestly instead of claiming "verified".
    return { status: 'NEEDS_REVIEW', result: 'Authenticode signature present (chain not validatable in this pipeline)', details: 'The PKCS#7 signature parses correctly. Chain-of-trust validation is not available in the current runtime — an admin review confirms it before publication.', pkcs7: certBlob };
  }

  if (platform === 'android') {
    const v2 = entries ? hasApkSigningBlock(bytes, entries) : false;
    let v1Cert: Uint8Array | null = null;
    if (entries) {
      const signing = entries.find((e) => /^META-INF\/.*\.(RSA|DSA|EC)$/i.test(e.name) && e.method === 0);
      if (signing) v1Cert = await extractZipEntry(bytes, signing);
    }
    if (!v2 && !v1Cert) {
      return { status: 'FAILED', result: 'unsigned APK', details: 'No v1 (JAR) signature file and no v2/v3 APK Signing Block found. Android requires signed packages — an unsigned APK will not install.' };
    }
    const mechanisms = [v2 ? 'v2/v3 signing block' : '', v1Cert ? 'v1 JAR signature' : ''].filter(Boolean).join(' + ');
    return { status: 'NEEDS_REVIEW', result: `APK signed (${mechanisms}; certificate chain not validatable in this pipeline)`, details: 'Signing structures are present and parse. Full certificate-chain verification is not available in the current runtime — an admin review confirms before publication.', pkcs7: v1Cert || null };
  }

  if (platform === 'linux_deb' || platform === 'linux_appimage') {
    return { status: 'NOT_APPLICABLE', result: `${platform} packages are not individually signed`, details: 'Debian signing happens at repository level; AppImage signing is not used by this marketplace. Integrity is enforced by the stored SHA-256.' };
  }

  return { status: 'NOT_APPLICABLE', result: 'no signature scheme for this platform' };
}

export async function checkCertificate(pkcs7: Uint8Array | null, now = new Date()): Promise<CheckResult> {
  if (!pkcs7) return { status: 'NOT_APPLICABLE', result: 'no signature to certify' };
  const cert = extractCertificateFromPkcs7(pkcs7);
  if (!cert) return { status: 'NEEDS_REVIEW', result: 'signing certificate could not be parsed' };
  const info = await certificateInfo(cert);
  if (!info || !info.notBefore || !info.notAfter) {
    return { status: 'NEEDS_REVIEW', result: 'certificate validity period unreadable' };
  }
  if (now < info.notBefore) return { status: 'WARNING', result: 'certificate not yet valid', details: `notBefore=${info.notBefore.toISOString()}`, fingerprint: info.fingerprintSha256 };
  if (now > info.notAfter) return { status: 'WARNING', result: 'signing certificate has EXPIRED', details: `notAfter=${info.notAfter.toISOString()} — the app may still install (Android tolerates expired signing certs) but this needs attention.`, fingerprint: info.fingerprintSha256 };
  return { status: 'PASSED', result: 'signing certificate within its validity period', fingerprint: info.fingerprintSha256, details: `valid ${info.notBefore.toISOString()} → ${info.notAfter.toISOString()}` };
}

// ---------------------------------------------------------------------------
// CHECK 7 — dependency / metadata security (provider-based, honest)
// ---------------------------------------------------------------------------

export async function checkDependencies(env: any, input: {
  platform: string; filename: string; sha256: string;
}): Promise<CheckResult> {
  // Native installers (.exe/.msi/.apk/.deb/.AppImage) embed no dependency
  // manifest this pipeline can read — that is a fact, not an omission.
  if (!env?.DEP_SECURITY_URL) {
    return { status: 'NOT_APPLICABLE', result: 'native packages embed no dependency manifest to analyze' };
  }
  try {
    const res = await fetch(String(env.DEP_SECURITY_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: input.platform, filename: input.filename, sha256: input.sha256 }),
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'UNAVAILABLE', result: `dependency checker responded ${res.status}` };
    const j: any = await res.json();
    const status = String(j?.status || '').toUpperCase();
    if (['PASSED', 'WARNING', 'FAILED'].includes(status)) {
      return { status: status as CheckStatus, provider: j?.provider || 'dep-checker', providerVersion: j?.version, result: j?.result || status, details: j?.details };
    }
    return { status: 'UNAVAILABLE', result: `unrecognized dependency-check status '${status}'` };
  } catch (e: any) {
    return { status: 'UNAVAILABLE', result: 'dependency checker unreachable', error: String(e?.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// CHECK 8 — native identity (package vs the app's registered identity)
// ---------------------------------------------------------------------------

export async function checkNativeIdentity(input: {
  platform: string; bytes: PackageBytes; entries: ZipEntry[] | null; app: {
    androidPackageId?: string | null; linuxPackageName?: string | null;
    windowsExecutable?: string | null; windowsUninstallKey?: string | null;
  };
}): Promise<CheckResult> {
  const { platform, bytes, entries, app } = input;

  if (platform === 'android') {
    const registered = String(app.androidPackageId || '').trim();
    if (!registered) {
      return { status: 'WARNING', result: 'no android_package_id registered', details: 'The application record has no Android package id. Installed-app detection and update matching will not work for this app. Set it in the app record.' };
    }
    const manifest = entries?.find((e) => e.name === 'AndroidManifest.xml');
    if (!manifest) return { status: 'FAILED', result: 'AndroidManifest.xml missing', details: 'Cannot verify the package id without a manifest.' };
    const xml = await extractZipEntry(bytes, manifest);
    if (!xml) return { status: 'NEEDS_REVIEW', result: 'AndroidManifest.xml could not be read (compression)' };
    // The binary AXML string pool holds the package id in UTF-8 or UTF-16LE.
    const utf8 = new TextDecoder('latin1').decode(xml);
    const utf16 = new TextDecoder('utf-16le').decode(xml);
    if (utf8.includes(registered) || utf16.includes(registered)) {
      return { status: 'PASSED', result: `manifest declares the registered package id ${registered}` };
    }
    return { status: 'FAILED', result: `package id mismatch`, details: `The registered Android package id is ${registered} but it does not appear in the uploaded package's manifest. This package may belong to a different application.` };
  }

  if (platform === 'linux_deb') {
    const registered = String(app.linuxPackageName || '').trim();
    const members = parseAr(bytes);
    if (!members) return { status: 'FAILED', result: 'not a valid .deb — cannot verify identity' };
    const { name, reason } = await readDebPackageName(bytes, members);
    if (!name) return { status: 'NEEDS_REVIEW', result: 'package name unreadable', details: reason };
    if (!registered) {
      return { status: 'WARNING', result: `package declares '${name}' but no linux_package_name is registered`, details: 'Register the expected package name on the app record so future uploads can be verified automatically.' };
    }
    if (name === registered) return { status: 'PASSED', result: `.deb Package: name matches the registered '${registered}'` };
    return { status: 'FAILED', result: 'package identity mismatch', details: `The .deb declares Package: ${name} but the app is registered as '${registered}'. This package may belong to a different application.` };
  }

  if (platform === 'windows') {
    // Windows installers carry no in-package identity this pipeline can
    // compare pre-install (the registry-based identity only exists after
    // installation). Honest result — identity is enforced post-install by
    // detection (windows_uninstall_key / windows_executable).
    const hasIdentity = !!(app.windowsExecutable || app.windowsUninstallKey);
    return {
      status: 'NOT_APPLICABLE',
      result: hasIdentity
        ? 'Windows identity is verified post-install via registry/executable detection'
        : 'no Windows identity registered on the app',
      details: hasIdentity
        ? 'Installers cannot be matched to registry keys before installation; detection enforces the identity on user devices.'
        : 'Register windows_executable / windows_uninstall_key on the app record for install detection.',
    };
  }

  return { status: 'NOT_APPLICABLE', result: `no native identity rule for ${platform}` };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const STAGE_FOR_CHECK: Record<CheckType, PipelineStage> = {
  structure: 'STRUCTURE_CHECK', integrity: 'INTEGRITY_CHECK', duplicate: 'DUPLICATE_CHECK',
  malware: 'MALWARE_SCAN', signature: 'SIGNATURE_CHECK', certificate: 'CERTIFICATE_CHECK',
  dependency: 'DEPENDENCY_SECURITY_CHECK', native_identity: 'NATIVE_IDENTITY_CHECK',
};

/** Recompute sha256 from the stored object and compare with the recorded hash. */
async function checkIntegrity(env: any, pkg: any, bytes: PackageBytes | null): Promise<CheckResult> {
  if (!bytes) return { status: 'FAILED', result: 'stored object missing', details: 'The package file could not be read from storage — re-upload it.' };
  if (pkg.file_size && bytes.size !== Number(pkg.file_size)) {
    return { status: 'FAILED', result: 'size mismatch', details: `The recorded size is ${pkg.file_size} bytes but storage holds ${bytes.size}.` };
  }
  if (bytes.full) {
    const actual = await sha256Hex(bytes.full);
    if (actual !== String(pkg.sha256).toLowerCase()) {
      return { status: 'FAILED', result: 'hash mismatch', details: `Recorded SHA-256 ${pkg.sha256} does not match the stored bytes (${actual}). The file may have been corrupted or tampered with.` };
    }
    return { status: 'PASSED', result: 'stored bytes match the recorded SHA-256' };
  }
  // Large packages: hash verification of the full object is not feasible in
  // the Worker (no streaming SHA-256) — say so instead of pretending.
  return { status: 'NEEDS_REVIEW', result: 'object too large for in-Worker full-hash verification', details: `Size ${(bytes.size / 1024 / 1024).toFixed(1)} MB exceeds the in-memory verification limit; the recorded hash was computed at upload time. Re-verify externally if required.` };
}

async function recordResult(env: any, pkg: any, check: CheckType, res: CheckResult, startedAt: number) {
  await env.DB.prepare(
    `INSERT INTO package_security_results (id, package_id, release_id, app_id, developer_id, check_type, status, classification, provider, provider_version, result, details, fingerprint, error, started_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(rid('psr'), pkg.id, pkg.release_id, pkg.application_id, pkg.developer_id ?? null, check, res.status,
    res.classification ?? null, res.provider ?? null, res.providerVersion ?? null, res.result,
    res.details ?? null, res.fingerprint ?? null, res.error ?? null,
    new Date(startedAt).toISOString(), new Date().toISOString()).run().catch(() => {});
}

/** Map per-check statuses to the overall verdict. Fail-closed everywhere. */
export function overallFromResults(results: CheckResult[]): 'PASSED' | 'FAILED' | 'NEEDS_REVIEW' {
  if (results.some((r) => r.status === 'FAILED' || r.status === 'DETECTED')) return 'FAILED';
  if (results.some((r) => ['WARNING', 'NEEDS_REVIEW', 'UNAVAILABLE', 'SCANNING', 'PENDING'].includes(r.status))) return 'NEEDS_REVIEW';
  return 'PASSED';
}

/**
 * Run the full pipeline for one package. Idempotent: re-running replaces the
 * verdicts with fresh rows (history is preserved in package_security_results).
 * Stops at the first FAILED stage (later stages are not run — the state
 * machine records where it stopped).
 */
export async function runSecurityPipeline(env: any, packageId: string): Promise<{
  state: PipelineStage; overall: 'PASSED' | 'FAILED' | 'NEEDS_REVIEW'; results: Partial<Record<CheckType, CheckResult>>;
}> {
  const pkg: any = await env.DB.prepare('SELECT * FROM packages WHERE id=?').bind(packageId).first().catch(() => null);
  if (!pkg) return { state: 'QUARANTINED', overall: 'FAILED', results: {} };

  // URL-based packages (web deployment) have no binary to verify.
  if (pkg.deployment_url) {
    await env.DB.prepare(`UPDATE packages SET security_state='SECURITY_REVIEW_COMPLETE', overall_security='PASSED', verified_at=datetime('now') WHERE id=?`).bind(packageId).run().catch(() => {});
    return { state: 'SECURITY_REVIEW_COMPLETE', overall: 'PASSED', results: {} };
  }

  const app: any = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(pkg.application_id).first().catch(() => null);
  const bytes = await loadPackageBytes(env, pkg.quarantine_key || pkg.storage_key);
  const results: Partial<Record<CheckType, CheckResult>> = {};
  let lastStage: PipelineStage = 'QUARANTINED';

  const run = async (check: CheckType, fn: () => Promise<CheckResult>): Promise<CheckResult> => {
    const t0 = Date.now();
    const res = await fn();
    results[check] = res;
    await recordResult(env, pkg, check, res, t0);
    lastStage = STAGE_FOR_CHECK[check];
    // Progress + the Phase 12 columns stay in sync per check.
    const scanCols = check === 'malware'
      ? `, security_scan_status='${res.status}'` + (['CLEAN', 'DETECTED', 'FAILED', 'UNAVAILABLE'].includes(res.status) ? `, scan_at=datetime('now')` : '')
      : '';
    const sigCols = check === 'signature' ? `, signature_status='${res.status === 'NEEDS_REVIEW' && res.result.includes('signed') ? 'SIGNED' : res.status === 'WARNING' && res.result.includes('unsigned') ? 'UNSIGNED' : res.status === 'FAILED' ? 'UNSIGNED' : res.status}'` : '';
    await env.DB.prepare(
      `UPDATE packages SET security_state=?, overall_security='PENDING'${scanCols}${sigCols} WHERE id=?`
    ).bind(STAGE_FOR_CHECK[check], packageId).run().catch(() => {});
    return res;
  };

  // 1. structure
  if ((await run('structure', () => checkStructure({
    platform: pkg.platform, architecture: pkg.architecture || 'x64', filename: pkg.filename, bytes: bytes ?? { size: 0, head: new Uint8Array(0), headOffset: 0, tail: new Uint8Array(0), tailOffset: 0, full: new Uint8Array(0) },
  }))).status === 'FAILED') return finish(env, packageId, lastStage, results, 'FAILED');

  // 2. integrity
  if ((await run('integrity', () => checkIntegrity(env, pkg, bytes))).status === 'FAILED') return finish(env, packageId, lastStage, results, 'FAILED');

  // 3. duplicate
  const dupRows: any = await env.DB.prepare(
    `SELECT p.id, p.application_id, p.platform, p.release_id, r.version AS release_version
     FROM packages p LEFT JOIN releases r ON r.id = p.release_id
     WHERE p.sha256 = ? AND p.id != ?`
  ).bind(pkg.sha256, packageId).all().catch(() => ({ results: [] }));
  await run('duplicate', async () => {
    const rows = (dupRows?.results || []).map((r: any) => ({ ...r, appId: r.application_id }));
    return classifyDuplicate({ sameShaElsewhere: rows, currentAppId: pkg.application_id, currentReleaseId: pkg.release_id, currentPlatform: pkg.platform, currentArch: pkg.architecture });
  });

  // 4. malware
  const malware = await run('malware', () => runMalwareScan(env, {
    sha256: pkg.sha256, filename: pkg.filename, size: Number(pkg.file_size) || 0, platform: pkg.platform,
  }));
  if (malware.status === 'DETECTED' || malware.status === 'FAILED') return finish(env, packageId, lastStage, results, 'FAILED');

  // 5. signature (+ extract PKCS#7 for the certificate check)
  let pkcs7: Uint8Array | null = null;
  const entries = ['android', 'web', 'pwa'].includes(pkg.platform) ? parseZipCentralDirectory(bytes ?? { size: 0, head: new Uint8Array(0), headOffset: 0, tail: new Uint8Array(0), tailOffset: 0, full: new Uint8Array(0) }) : null;
  const sig = await run('signature', () => checkSignature({ platform: pkg.platform, bytes: bytes!, entries }));
  pkcs7 = (sig as SignatureOutcome).pkcs7 ?? null;

  // 6. certificate
  await run('certificate', () => checkCertificate(pkcs7));

  // 7. dependency
  await run('dependency', () => checkDependencies(env, { platform: pkg.platform, filename: pkg.filename, sha256: pkg.sha256 }));

  // 8. native identity (camelCase mapping from the raw applications row)
  await run('native_identity', () => checkNativeIdentity({
    platform: pkg.platform, bytes: bytes!, entries,
    app: {
      androidPackageId: app?.android_package_id ?? null,
      linuxPackageName: app?.linux_package_name ?? null,
      windowsExecutable: app?.windows_executable ?? null,
      windowsUninstallKey: app?.windows_uninstall_key ?? null,
    },
  }));

  return finish(env, packageId, 'SECURITY_REVIEW_COMPLETE', results, overallFromResults(Object.values(results) as CheckResult[]));
}

async function finish(env: any, packageId: string, state: PipelineStage, results: Partial<Record<CheckType, CheckResult>>, overall: 'PASSED' | 'FAILED' | 'NEEDS_REVIEW') {
  await env.DB.prepare(
    `UPDATE packages SET security_state=?, overall_security=?, verified_at=datetime('now') WHERE id=?`
  ).bind(state, overall, packageId).run().catch(() => {});
  return { state, overall, results };
}

/**
 * Publication gate: every binary package of the release must be
 * SECURITY_REVIEW_COMPLETE/PASSED (or carry an explicit admin override).
 * URL packages (web deployments) have nothing to gate.
 */
export async function publicationSecurityGate(env: any, releaseId: string): Promise<{
  ok: boolean; blockers: Array<{ packageId: string; platform: string; filename: string; state: string; overall: string; reasons: string[] }>;
}> {
  const pkgs: any = await env.DB.prepare('SELECT * FROM packages WHERE release_id=?').bind(releaseId).all().catch(() => ({ results: [] }));
  const blockers: Array<{ packageId: string; platform: string; filename: string; state: string; overall: string; reasons: string[] }> = [];
  for (const p of pkgs?.results || []) {
    if (p.deployment_url) continue; // URL-based web packages
    const needsRun = !p.security_state || p.security_state === 'QUARANTINED';
    if (needsRun) await runSecurityPipeline(env, p.id).catch(() => {});
    const fresh: any = await env.DB.prepare('SELECT * FROM packages WHERE id=?').bind(p.id).first().catch(() => null);
    if (!fresh) continue;
    const overridden: any = await env.DB.prepare(
      `SELECT id FROM package_security_overrides WHERE package_id=? LIMIT 1`
    ).bind(p.id).first().catch(() => null);
    if (overridden) continue;
    const failReasons: any = await env.DB.prepare(
      `SELECT check_type, status, result, details FROM package_security_results WHERE package_id=? AND id IN (
         SELECT MAX(id) FROM package_security_results WHERE package_id=? GROUP BY check_type
       ) AND status IN ('FAILED','DETECTED','WARNING','NEEDS_REVIEW','UNAVAILABLE','PENDING','SCANNING')`
    ).bind(p.id, p.id).all().catch(() => ({ results: [] }));
    if (fresh.overall_security !== 'PASSED' || fresh.security_state !== 'SECURITY_REVIEW_COMPLETE') {
      blockers.push({
        packageId: p.id, platform: p.platform, filename: p.filename,
        state: fresh.security_state || 'QUARANTINED', overall: fresh.overall_security || 'PENDING',
        reasons: (failReasons?.results || []).map((r: any) => `${r.check_type}: ${r.status} — ${r.result}${r.details ? ` (${r.details})` : ''}`),
      });
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Serving-layer gate for the /r2/ route (Phase 13 §1): package binaries
 * (apps/* and quarantine/*) are publicly downloadable ONLY when the owning
 * package row is published. Everything else (assets/*, icons, screenshots)
 * stays public as before.
 */
export async function r2KeyIsPubliclyServed(env: any, key: string): Promise<boolean> {
  if (!key.startsWith('apps/') && !key.startsWith('quarantine/')) return true;
  const row: any = await env.DB.prepare('SELECT status FROM packages WHERE storage_key=? LIMIT 1').bind(key).first().catch(() => null);
  return !!row && row.status === 'published';
}

/** Latest check results per package (for admin + developer security views). */
export async function latestChecksForPackages(env: any, packageIds: string[]): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  for (const id of packageIds) {
    const rows: any = await env.DB.prepare(
      `SELECT check_type, status, classification, provider, provider_version, result, details, fingerprint, error, completed_at FROM package_security_results
       WHERE id IN (SELECT MAX(id) FROM package_security_results WHERE package_id=? GROUP BY check_type)
       ORDER BY check_type`
    ).bind(id).all().catch(() => ({ results: [] }));
    out[id] = rows?.results || [];
  }
  return out;
}
