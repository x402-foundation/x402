import prettier from "prettier";

/**
 * Format a TypeScript file's contents using the paywall package's prettier
 * config. Used to keep auto-generated template files byte-identical to what
 * `pnpm run format` would emit, so CI drift checks stay reliable.
 *
 * @param filePath - Absolute or relative path used by prettier for config
 *   resolution and filetype inference.
 * @param contents - Source contents to format.
 * @returns The prettier-formatted contents.
 */
export async function formatTypeScript(filePath: string, contents: string): Promise<string> {
  const config = await prettier.resolveConfig(filePath);
  return prettier.format(contents, { ...config, filepath: filePath });
}

/**
 * Serialize a string as a Python source literal, choosing the quote style
 * that requires fewer escapes. Mirrors ruff/black's default behavior so that
 * `ruff format --check` is a no-op on generated files.
 *
 * @param s - Input string to serialize.
 * @returns A Python string literal (quoted and escaped) representing `s`.
 */
export function toPythonStringLiteral(s: string): string {
  const singleCount = (s.match(/'/g) || []).length;
  const doubleCount = (s.match(/"/g) || []).length;
  const useSingle = doubleCount > singleCount;
  const quote = useSingle ? "'" : '"';

  let body = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\f/g, "\\f")
    .replace(/\v/g, "\\v")
    .replace(
      /[\x00-\x08\x0e-\x1f\x7f]/g,
      c => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
  body = useSingle ? body.replace(/'/g, "\\'") : body.replace(/"/g, '\\"');
  return `${quote}${body}${quote}`;
}
