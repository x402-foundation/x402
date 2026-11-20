#!/usr/bin/env node
/**
 * Verifies every top-level `types` entry and `exports.*.types` target in workspace
 * package declaration targets exist on disk, post-build.
 *
 * This is a safety net for build-config changes like `mirror-cjs-dts.mjs`
 * (typescript/scripts/mirror-cjs-dts.mjs): a script or tsup config mistake there could
 * leave a declared `.d.ts`/`.d.cts` target missing while the build itself still exits 0,
 * silently shipping a package that resolves at runtime but has no types for some
 * subpath. Run this after building the workspace (e.g. `pnpm build && pnpm verify:exports`
 * from `typescript/`, or rely on CI/publish workflows that run `pnpm verify:exports`).
 *
 * Scans all packages, including `packages/legacy/*`; legacy export targets are still
 * checked, but frozen packages are exempt from the current-package top-level `types`
 * and `typesVersions` checks.
 *
 * Packages with no `dist/` directory are skipped for on-disk target checks (expected for scoped builds).
 * Exits non-zero when no package was checked unless `VERIFY_EXPORTS_ALLOW_EMPTY=1`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPESCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories (relative to the `typescript/` root) whose immediate subdirectories are packages. */
const PACKAGE_GLOBS = [
  'packages', // core, extensions, mcp themselves live directly here
  'packages/http',
  'packages/mechanisms',
  'packages/legacy',
]

/**
 * @param message - Error detail
 * @returns Nothing; prints and exits 1
 */
function fail(message) {
  console.error(`[verify-package-exports] ${message}`)
  process.exit(1)
}

/**
 * Lists directories directly under `dir` that contain a `package.json`.
 *
 * @param dir - Absolute directory to scan
 * @returns Absolute paths of immediate child directories containing a `package.json`
 */
function listPackageDirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((full) => {
      let isDirectory
      try {
        isDirectory = statSync(full).isDirectory()
      } catch (err) {
        fail(`Cannot stat "${full}": ${err.message}`)
      }
      return isDirectory && existsSync(join(full, 'package.json'))
    })
}

/**
 * @param packageDir - Absolute path to the package directory
 * @returns Parsed package.json object
 */
function readPackageJson(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  let raw
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (err) {
    fail(`Cannot read "${manifestPath}": ${err.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    fail(`Invalid JSON in "${manifestPath}": ${err.message}`)
  }
}

/**
 * Recursively collects every string value found under an `"exports"` map's `"types"`
 * keys, at any nesting depth (subpaths, conditions, arrays of fallback conditions).
 *
 * @param node - Current `exports` subtree (object, array, or string)
 * @param inTypesKey - Whether `node` is itself the value of a `"types"` key
 * @param found - Accumulator (used for the recursive call; omit at the top level)
 * @returns Every `"types"` target string found in this subtree
 */
function collectTypesTargets(node, inTypesKey = false, found = []) {
  if (typeof node === 'string') {
    if (inTypesKey) found.push(node)
    return found
  }
  if (Array.isArray(node)) {
    for (const entry of node) collectTypesTargets(entry, inTypesKey, found)
    return found
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectTypesTargets(value, key === 'types', found)
    }
  }
  return found
}

/**
 * Verifies one package's declaration entrypoints exist on disk. Returns `null` (skip)
 * for a package with no `dist/` directory, as only selected workspace packages may be built.
 * Legacy package top-level `types` fields are ignored because those packages are frozen;
 * their `exports.*.types` targets are still validated.
 *
 * @param packageDir - Absolute path to the package directory
 * @returns Missing declaration targets (relative to the package directory), or `null` if skipped
 */
function verifyPackage(packageDir) {
  const pkg = readPackageJson(packageDir)
  if (!pkg.exports && (isLegacyPackage(packageDir) || !pkg.types)) return []
  if (!existsSync(join(packageDir, 'dist'))) return null

  const targets = pkg.exports ? collectTypesTargets(pkg.exports) : []
  if (!isLegacyPackage(packageDir) && typeof pkg.types === 'string') targets.push(pkg.types)
  return [...new Set(targets)].filter((target) => !existsSync(join(packageDir, target)))
}

/**
 * Checks whether a package belongs to the frozen legacy namespace.
 *
 * @param packageDir - Absolute path to the package directory
 * @returns True when the package is in `packages/legacy`
 */
function isLegacyPackage(packageDir) {
  return relative(TYPESCRIPT_ROOT, packageDir).startsWith(join('packages', 'legacy') + sep)
}

/**
 * Verifies every current package's explicit subpath export has a legacy-resolution mapping.
 * Frozen legacy packages are intentionally excluded.
 *
 * @param packageDir - Absolute path to the package directory
 * @returns Missing `typesVersions` mappings
 */
function verifyTypesVersions(packageDir) {
  if (isLegacyPackage(packageDir)) return []

  const pkg = readPackageJson(packageDir)
  if (!pkg.exports || typeof pkg.exports !== 'object') return []

  const mappings = pkg.typesVersions?.['*'] ?? {}
  const missing = []
  for (const [subpath, exportMap] of Object.entries(pkg.exports)) {
    if (!subpath.startsWith('./')) continue

    const target = exportMap?.require?.types
    const key = subpath.slice(2)
    if (typeof target !== 'string') {
      missing.push(`${subpath}: missing an exports require.types target`)
      continue
    }
    if (!Array.isArray(mappings[key]) || !mappings[key].includes(target)) {
      missing.push(`${subpath}: typesVersions["*"]["${key}"] must include "${target}"`)
    }
  }
  return missing
}


/**
 * Verifies declaration targets and legacy-resolution mappings for every current package.
 *
 * @returns Nothing; prints a report and exits 1 if any target is missing
 */
function main() {
  const packageDirs = PACKAGE_GLOBS.flatMap((glob) => listPackageDirs(join(TYPESCRIPT_ROOT, glob)))

  if (packageDirs.length === 0) {
    fail('No workspace packages found (check PACKAGE_GLOBS).')
  }

  let checkedCount = 0
  let skippedCount = 0
  let missingCount = 0
  let missingMappingCount = 0

  for (const packageDir of packageDirs) {
    const missingMappings = verifyTypesVersions(packageDir)
    if (missingMappings.length > 0) {
      missingMappingCount += missingMappings.length
      const name = readPackageJson(packageDir).name
      for (const mapping of missingMappings) {
        console.error(`[verify-package-exports] ${name}: ${mapping}`)
      }
    }

    const missing = verifyPackage(packageDir)
    if (missing === null) {
      skippedCount += 1
      continue
    }
    checkedCount += 1
    if (missing.length > 0) {
      missingCount += missing.length
      const name = readPackageJson(packageDir).name
      for (const target of missing) {
        console.error(`[verify-package-exports] ${name}: missing "${target}" (declared in package.json)`)
      }
    }
  }

  if (missingCount > 0 || missingMappingCount > 0) {
    console.error(
      `[verify-package-exports] ${missingCount} missing type target(s) across ${checkedCount} built package(s) (${skippedCount} unbuilt package(s) skipped), and ${missingMappingCount} missing typesVersions mapping(s).`,
    )
    process.exit(1)
  }

  const allowEmpty = process.env.VERIFY_EXPORTS_ALLOW_EMPTY === '1'
  if (checkedCount === 0 && !allowEmpty) {
    fail(
      `No built packages to check (${skippedCount} package(s) have no dist/). ` +
        'Run a workspace build first (e.g. `pnpm build` from typescript/). ' +
        'Set VERIFY_EXPORTS_ALLOW_EMPTY=1 to allow exit 0 with zero checks.',
    )
  }

  console.log(
    `[verify-package-exports] All declaration targets exist (${checkedCount} built package(s) checked, ${skippedCount} unbuilt package(s) skipped); current package subpaths have typesVersions mappings.`,
  )
}

main()
