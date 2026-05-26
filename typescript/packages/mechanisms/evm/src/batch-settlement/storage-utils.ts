import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Returns true when `err` is a Node.js `ENOENT` filesystem error (file does not exist).
 *
 * @param err - The thrown value to inspect.
 * @returns `true` for `ENOENT`, `false` for any other value or error code.
 */
export function isNodeEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Reads a JSON file and parses it. Returns `undefined` if the file does not exist.
 * Other errors (permission, malformed JSON) are rethrown.
 *
 * @param filePath - Path to the JSON file.
 * @returns Parsed value, or `undefined` for `ENOENT`.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (isNodeEnoent(err)) return undefined;
    throw err;
  }
}

/**
 * Writes JSON to `filePath` atomically (temp file in the same directory, then rename).
 * Creates parent directories as needed.
 *
 * @param filePath - Destination file path; parent dirs are created if missing.
 * @param value - JSON-serializable value to persist.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, body, "utf8");
  try {
    await rename(tmp, filePath);
  } catch {
    // On Windows, rename() onto an existing file throws EEXIST; unlink + rename is intentional.
    await unlink(filePath).catch(() => {});
    await rename(tmp, filePath);
  }
}
