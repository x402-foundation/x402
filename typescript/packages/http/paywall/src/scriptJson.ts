/**
 * Serializes a value as JSON for an inline <script>. JSON.stringify leaves "<"
 * as is, so a string containing "</script>" would close the element; inside a
 * JS string "<" is the same character.
 *
 * @param value - Value to serialize
 * @returns JSON with every "<" escaped
 */
export function toScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
