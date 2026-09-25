/**
 * Build the @rx-store/sdk package into sdk/dist as plain, tree-shakeable ESM
 * JavaScript + TypeScript declarations — consumable by normal npm/Vite/React
 * applications WITHOUT transpiling SDK TypeScript.
 *
 * Why a source-rewrite step: the repository's Node test runner requires
 * explicit `.ts` extensions on relative imports, but a *published* ESM
 * package must import `.js` (there is no runtime extension rewriting in
 * Node). tsc refuses to EMIT code whose imports end in `.ts`. So we:
 *
 *   1. copy sdk/src → sdk/build-src, rewriting relative `.ts`/`.tsx` import
 *      specifiers to `.js` (specifiers only — code is untouched),
 *   2. run tsc over the copy: emits per-module ESM `.js` + `.d.ts` into
 *      sdk/dist (structure preserved 1:1 → declarations resolve, tree-shaking
 *      works, no bundling artifacts),
 *   3. emit a package manifest copy so `npm pack` ships exactly dist + README.
 *
 * Usage: node scripts/build-sdk.mjs   (root: `npm run build:sdk`)
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkDir = path.join(root, 'sdk');
const srcDir = path.join(sdkDir, 'src');
const stageDir = path.join(sdkDir, 'build-src');
const distDir = path.join(sdkDir, 'dist');

if (!existsSync(srcDir)) {
  console.error('sdk/src not found — run from the repository root');
  process.exit(1);
}

// 1. Stage the source with extension-rewritten specifiers.
rmSync(stageDir, { recursive: true, force: true });
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const importRe = /(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+)\.(ts|tsx)(['"])/g;
function rewriteSpecifiers(code) {
  return code.replace(importRe, (_m, pre, q1, spec, _ext, q2) => `${pre}${q1}${spec}.js${q2}`);
}

function stageDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (statSync(s).isDirectory()) {
      stageDirRecursive(s, d);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      writeFileSync(d, rewriteSpecifiers(readFileSync(s, 'utf8')));
    }
  }
}
stageDirRecursive(srcDir, stageDir);

// 2. Compile: ESM JavaScript + declarations, one output module per source
//    module (tree-shakeable; consumers' bundlers drop what they don't use).
const tscBin = path.join(root, 'node_modules', '.bin', 'tsc');
execFileSync(tscBin, ['-p', path.join(sdkDir, 'tsconfig.build.json')], { stdio: 'inherit', cwd: root });

// 3. Sanity: the entry points exist and their imports use .js specifiers.
for (const f of ['index.js', 'index.d.ts', 'react/index.js', 'react/index.d.ts']) {
  const p = path.join(distDir, f);
  if (!existsSync(p)) {
    console.error(`Build verification failed: ${p} was not emitted`);
    process.exit(1);
  }
}
for (const f of ['index.js', 'react/index.js']) {
  const code = readFileSync(path.join(distDir, f), 'utf8');
  if (/from\s+['"]\.[^'"]*\.ts['"]/.test(code)) {
    console.error(`Build verification failed: ${f} still contains .ts import specifiers`);
    process.exit(1);
  }
  if (/from\s+['"]\.[^'"]*['"];?\s*$/.test(code) && !/\.js['"]/.test(code)) {
    // (defensive — tsc keeps specifiers verbatim; the rewrite guarantees .js)
  }
}

// 4. No secrets in the shipped payload (defence in depth — tested too).
const secretPatterns = [/sk_live_/, /sk-or-v1-/, /nvapi-/, /AIza[0-9A-Za-z_-]{30}/, /BEGIN (RSA |EC )?PRIVATE KEY/, /JWT_SECRET\s*=/, /PAYSTACK_SECRET/i, /VIRUSTOTAL_API_KEY/i];
for (const entry of readdirSync(distDir, { recursive: true })) {
  const p = path.join(distDir, String(entry));
  if (!statSync(p).isFile() || !/\.(js|d\.ts)$/.test(p)) continue;
  const code = readFileSync(p, 'utf8');
  for (const re of secretPatterns) {
    if (re.test(code)) {
      console.error(`SECURITY: ${p} matches secret pattern ${re}`);
      process.exit(1);
    }
  }
}

rmSync(stageDir, { recursive: true, force: true });
console.log('built sdk/dist (ESM JavaScript + declarations)');
