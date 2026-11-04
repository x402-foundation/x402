/**
 * x402 v2 wire types.
 *
 * <p>Field names and optionality follow {@code specs/x402-specification-v2.md}. All types are records whose
 * collection components are copied into unmodifiable collections on construction. Free-form JSON maps such
 * as {@code extra}, {@code payload} and {@code extensions} are copied shallowly: nested maps and lists inside
 * them are not. Absent optional fields are {@code null} and are omitted from serialized JSON.
 */
package org.x402.types;
