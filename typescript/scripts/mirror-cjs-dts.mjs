#!/usr/bin/env node
/**
 * Mirrors the ESM declaration files tsup already generated (dist/esm) into dist/cjs,
 * instead of running tsup's (expensive) DTS rollup a second time for the CJS build.
 * Package type content does not differ between module formats — only the runtime
 * import/export syntax does — so generating it twice is pure duplicate work that
 * roughly doubles peak memory during `tsup` (measured: @x402/evm 5.4GB -> 2.7GB,
 * @x402/svm 3.3GB -> 1.7GB, @x402/core 2.0GB -> 1.0GB, @x402/extensions 1.6GB -> 0.8GB
 * when generated once instead of twice).
 *
 * Handles both declaration-extension conventions used across this workspace's packages:
 * - No `"type": "module"` in package.json: ESM declarations are `.d.mts` (the explicit
 *   extension disambiguates them from the CJS build's plain `.d.ts`). Mirrored to
 *   `.d.ts`, rewriting internal `.mjs` specifiers to `.js`.
 * - `"type": "module"` in package.json: ESM declarations are plain `.d.ts` (already
 *   unambiguous, since ESM is the default). Mirrored to `.d.cts`, rewriting internal
 *   `.js` specifiers to `.cjs` (matching how tsup names *this* convention's actual CJS
 *   JS output).
 * Detected automatically per package by checking which extension is present in
 * dist/esm — no configuration needed.
 *
 * Mirrored files' internal relative import/export specifiers are rewritten only to the
 * extension matching the target format; the referenced chunk hash names themselves are
 * left as-is (identical to the ESM build's), which will not literally match the CJS
 * build's own (independently, differently-hashed) JS chunk files. That's fine: `.d.ts`
 * files are compile-time-only and never `require()`/`import()`-ed at runtime; TypeScript
 * only needs the referenced declaration file to exist, which this script guarantees by
 * mirroring every chunk, not just each entry point's own file.
 *
 * Run from a package's root (i.e. as a step in that package's own `build` script, after
 * `tsup`), operating on `dist/esm` and `dist/cjs` relative to the current working
 * directory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ESM_DIR = 'dist/esm'
const CJS_DIR = 'dist/cjs'

/**
 * Recursively collects every file under a directory whose name ends with `suffix`.
 *
 * @param dir - Directory to search
 * @param suffix - File name suffix to match (e.g. `.d.mts`)
 * @param files - Accumulator (used for the recursive call; omit at the top level)
 * @returns Paths (relative to `process.cwd()`) of every matching file found
 */
function findFiles(dir, suffix, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      findFiles(full, suffix, files)
    } else if (entry.endsWith(suffix)) {
      files.push(full)
    }
  }
  return files
}

/**
 * Mirrors every ESM declaration file into the CJS output directory, auto-detecting
 * which declaration-extension convention this package uses.
 *
 * @returns Nothing; writes files and logs a summary to stdout
 */
function main() {
  if (!existsSync(ESM_DIR)) {
    console.error(`[mirror-cjs-dts] ${ESM_DIR} does not exist; nothing to mirror.`)
    process.exit(1)
  }

  const mtsFiles = findFiles(ESM_DIR, '.d.mts')
  // No ".d.mts" files means this package has "type": "module" (ESM declarations are
  // plain ".d.ts" there, since ESM is already the ambient default).
  const isTypeModulePackage = mtsFiles.length === 0

  const sourceSuffix = isTypeModulePackage ? '.d.ts' : '.d.mts'
  const targetSuffix = isTypeModulePackage ? '.d.cts' : '.d.ts'
  const sourceJsExt = isTypeModulePackage ? '.js' : '.mjs'
  const targetJsExt = isTypeModulePackage ? '.cjs' : '.js'

  const sourceFiles = isTypeModulePackage ? findFiles(ESM_DIR, sourceSuffix) : mtsFiles
  const specifierPattern = new RegExp(`(['"]\\.[^'"]*?)\\${sourceJsExt}(['"])`, 'g')

  for (const esmFile of sourceFiles) {
    const relative = esmFile.slice(ESM_DIR.length + 1)
    const cjsFile = join(CJS_DIR, relative.slice(0, -sourceSuffix.length) + targetSuffix)
    mkdirSync(dirname(cjsFile), { recursive: true })
    const content = readFileSync(esmFile, 'utf8').replace(specifierPattern, `$1${targetJsExt}$2`)
    writeFileSync(cjsFile, content)
  }

  console.log(`[mirror-cjs-dts] Mirrored ${sourceFiles.length} declaration file(s) into ${CJS_DIR}`)
}

main()
