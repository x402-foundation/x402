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
 * Applied to every tsup-based package in this workspace except `typescript/packages/legacy/*`,
 * which is intentionally excluded: it is frozen (security patches only) per
 * `.agents/skills/contributing/SKILL.md`, so its build config is left untouched.
 *
 * Handles both declaration-extension conventions used across this workspace's packages,
 * determined from each package's own `package.json` `"type"` field (authoritative —
 * this is what actually determines the convention tsup uses, so it is read directly
 * rather than inferred from build output, which can be empty, stale, or mixed):
 * - No `"type": "module"`: ESM declarations are `.d.mts` (the explicit extension
 *   disambiguates them from the CJS build's plain `.d.ts`). Mirrored to `.d.ts`,
 *   rewriting internal `.mjs` specifiers to `.js`.
 * - `"type": "module"`: ESM declarations are plain `.d.ts` (already unambiguous,
 *   since ESM is the default). Mirrored to `.d.cts`, rewriting internal `.js`
 *   specifiers to `.cjs` (matching how tsup names *this* convention's actual CJS JS
 *   output).
 * The expected source files are also scanned as a consistency check: if none are
 * found where the declared `"type"` says they should be, or if we find the *other*
 * convention's files instead, that indicates a stale or failed ESM build, and this
 * script exits 1 rather than silently mirroring zero (or wrong) files.
 *
 * Before writing, every existing `dist/cjs` file matching the target suffix (and
 * companion `*.d.*.map` declaration sourcemaps when present) is deleted, since tsup's
 * CJS config uses `clean: false` (ESM's `clean: true` already removes stale dist/esm
 * output). Without this, a renamed entry or a chunk whose content-hash changed would
 * leave its old declaration file behind, silently masking a type that no longer has
 * a live source.
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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const ESM_DIR = 'dist/esm'
const CJS_DIR = 'dist/cjs'

/**
 * @param message - Error detail
 * @returns Nothing; prints and exits 1
 */
function fail(message) {
  console.error(`[mirror-cjs-dts] ${message}`)
  process.exit(1)
}

/**
 * Recursively collects every file under a directory whose name ends with `suffix`.
 * Returns an empty array (rather than throwing) when `dir` does not exist, so callers
 * can use it for the CJS side before any CJS output has ever been written.
 *
 * @param dir - Directory to search
 * @param suffix - File name suffix to match (e.g. `.d.mts`)
 * @param files - Accumulator (used for the recursive call; omit at the top level)
 * @returns Paths (relative to `process.cwd()`) of every matching file found
 */
function findFiles(dir, suffix, files = []) {
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let isDirectory
    try {
      isDirectory = statSync(full).isDirectory()
    } catch (err) {
      fail(`Cannot stat "${full}": ${err.message}`)
    }
    if (isDirectory) {
      findFiles(full, suffix, files)
    } else if (entry.endsWith(suffix)) {
      files.push(full)
    }
  }
  return files
}

/**
 * Reads whether this package is ESM-by-default, from its own `package.json` — the
 * authoritative source for which declaration-extension convention tsup used, since
 * build output can be empty, stale, or (after a manual partial rebuild) mixed.
 *
 * @returns True when `package.json` declares `"type": "module"`
 */
function isTypeModulePackage() {
  let raw
  try {
    raw = readFileSync('package.json', 'utf8')
  } catch (err) {
    fail(`Cannot read package.json: ${err.message}`)
  }
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch (err) {
    fail(`Invalid JSON in package.json: ${err.message}`)
  }
  return pkg.type === 'module'
}

/**
 * Rewrites ESM declaration text for the mirrored CJS declaration file.
 *
 * @param content - ESM declaration file contents
 * @param options - Suffix and runtime extension mapping for this package convention
 * @returns Content suitable for the CJS-side declaration file
 */
function rewriteDeclarationContent(content, { sourceSuffix, targetSuffix, sourceJsExt, targetJsExt }) {
  // Assumes tsup DTS output only uses quoted relative import/export specifiers whose
  // paths end in `.mjs` (non-"type":"module" packages) or `.js` ("type":"module").
  // Does not rewrite `/// <reference path="...">`, query/hash imports, or specifiers
  // inside comments — extend this if a tsup upgrade changes declaration shape.
  const specifierPattern = new RegExp(`(['"]\\.[^'"]*?)\\${sourceJsExt}(['"])`, 'g')
  const sourceMapSuffix = `${sourceSuffix}.map`
  const targetMapSuffix = `${targetSuffix}.map`
  return content
    .replace(specifierPattern, `$1${targetJsExt}$2`)
    .replaceAll(sourceMapSuffix, targetMapSuffix)
}

/**
 * Mirrors every ESM declaration file into the CJS output directory.
 *
 * @returns Nothing; writes files and logs a summary to stdout, or exits 1 on failure
 */
function main() {
  if (!existsSync(ESM_DIR)) {
    fail(
      `${ESM_DIR} does not exist. Run this script from a package root, ` +
        'as a build step after tsup (e.g. `tsup && node .../mirror-cjs-dts.mjs`).',
    )
  }

  const typeModule = isTypeModulePackage()
  const sourceSuffix = typeModule ? '.d.ts' : '.d.mts'
  const otherSuffix = typeModule ? '.d.mts' : '.d.ts'
  const targetSuffix = typeModule ? '.d.cts' : '.d.ts'
  const sourceJsExt = typeModule ? '.js' : '.mjs'
  const targetJsExt = typeModule ? '.cjs' : '.js'
  const sourceMapSuffix = `${sourceSuffix}.map`
  const targetMapSuffix = `${targetSuffix}.map`

  const rewriteOptions = { sourceSuffix, targetSuffix, sourceJsExt, targetJsExt }

  const sourceFiles = findFiles(ESM_DIR, sourceSuffix)

  // Consistency check: package.json's "type" field determines the convention tsup
  // actually used, but a stale ESM build (e.g. left over from before "type" changed,
  // or from a failed partial rebuild) could disagree with it. Finding files in the
  // *other* convention's shape, or none in the expected one, means the ESM build is
  // not in the state this script assumes — fail loudly rather than silently mirroring
  // nothing (or mirroring stale, wrongly-shaped files).
  if (sourceFiles.length === 0) {
    const foundOther = findFiles(ESM_DIR, otherSuffix).length
    const hint = foundOther
      ? ` Found ${foundOther} "${otherSuffix}" file(s) instead — package.json's "type" ` +
        `field may not match what the ESM build actually produced; rebuild with \`tsup\` first.`
      : ''
    fail(`No "${sourceSuffix}" declaration files found under ${ESM_DIR}.${hint}`)
  }

  // Prune stale mirrors before writing fresh ones. tsup's CJS config uses
  // `clean: false`, so a renamed entry or a chunk whose content-hash changed since
  // the last build would otherwise leave its old declaration file behind, masking a
  // type that no longer has a live ESM source.
  for (const staleFile of findFiles(CJS_DIR, targetSuffix)) {
    unlinkSync(staleFile)
  }
  for (const staleMap of findFiles(CJS_DIR, targetMapSuffix)) {
    unlinkSync(staleMap)
  }

  let mirroredMaps = 0

  for (const esmFile of sourceFiles) {
    const relative = esmFile.slice(ESM_DIR.length + 1)
    const cjsFile = join(CJS_DIR, relative.slice(0, -sourceSuffix.length) + targetSuffix)
    mkdirSync(dirname(cjsFile), { recursive: true })
    const content = rewriteDeclarationContent(readFileSync(esmFile, 'utf8'), rewriteOptions)
    writeFileSync(cjsFile, content)

    const esmMapFile = esmFile.slice(0, -sourceSuffix.length) + sourceMapSuffix
    if (existsSync(esmMapFile)) {
      const cjsMapFile = join(CJS_DIR, relative.slice(0, -sourceSuffix.length) + targetMapSuffix)
      mkdirSync(dirname(cjsMapFile), { recursive: true })
      writeFileSync(cjsMapFile, readFileSync(esmMapFile))
      mirroredMaps += 1
    }
  }

  const mapSummary =
    mirroredMaps > 0 ? ` and ${mirroredMaps} declaration sourcemap(s)` : ''
  console.log(
    `[mirror-cjs-dts] Mirrored ${sourceFiles.length} declaration file(s)${mapSummary} into ${CJS_DIR}`,
  )
}

main()
