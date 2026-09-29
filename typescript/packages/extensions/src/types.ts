/**
 * Shared type utilities for x402 extensions
 */

/**
 * Type utility to merge extensions properly when chaining.
 * If T already has extensions, merge them; otherwise add new extensions.
 *
 * @example
 * ```ts
 * // Chaining multiple extensions preserves all types:
 * const client = withBazaar(withOtherExtension(new HTTPFacilitatorClient()));
 * // Type: HTTPFacilitatorClient & { extensions: OtherExtension & BazaarExtension }
 * ```
 */
export type WithExtensions<T, E> = T extends { extensions: infer Existing }
  ? Omit<T, "extensions"> & { extensions: Existing & E }
  : T & { extensions: E };
