/**
 * Converts an object to a JSON-safe format by converting bigint values to strings
 * and recursively processing nested objects and arrays
 *
 * @param data - The object to convert to JSON-safe format
 * @returns A new object with all bigint values converted to strings
 */
export function toJsonSafe<T extends object>(data: T): object {
  if (typeof data !== "object") {
    throw new Error("Data is not an object");
  }

  /**
   * Recursively converts values to JSON-safe format
   *
   * @param value - The value to convert
   * @returns The converted value with bigints as strings
   */
  function convert(value: unknown): unknown {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, convert(val)]));
    }

    if (Array.isArray(value)) {
      return value.map(convert);
    }

    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  }

  return convert(data) as object;
}
