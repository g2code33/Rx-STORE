// Builds the Electron main + preload bundles as CommonJS with a .cjs
// extension (required because package.json has "type": "module").
// esbuild's --out-extension flag cannot rename .js, so we rename after build.
import { build } from 'esbuild'
import { renameSync, mkdirSync } from 'node:fs'

mkdirSync('dist-electron', { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron', 'electron-updater'],
  logLevel: 'warning',
}

for (const entry of ['main', 'preload']) {
  const tmp = `dist-electron/${entry}.js`
  await build({ ...common, entryPoints: [`electron/${entry}.ts`], outfile: tmp })
  renameSync(tmp, `dist-electron/${entry}.cjs`)
  console.log(`built dist-electron/${entry}.cjs`)
}
