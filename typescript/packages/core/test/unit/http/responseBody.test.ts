import { describe, expect, it } from "vitest";
import {
  MAX_CONTROL_PLANE_RESPONSE_BYTES,
  ResponseBodyTooLargeError,
  readLimitedText,
} from "../../../src/http/responseBody";

/**
 * Builds a response whose body arrives in chunks, so the reader cannot rely on
 * Content-Length.
 *
 * @param chunks - Byte chunks delivered in order
 * @returns A response streaming those chunks
 */
function streamed(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream);
}

describe("readLimitedText", () => {
  it("returns a body under the limit", async () => {
    await expect(readLimitedText(new Response("payload"), 32)).resolves.toBe("payload");
  });

  it("returns a body exactly at the limit", async () => {
    const body = "a".repeat(64);
    await expect(readLimitedText(new Response(body), 64)).resolves.toBe(body);
  });

  it("rejects a body one byte over the limit", async () => {
    await expect(readLimitedText(new Response("a".repeat(65)), 64)).rejects.toThrow(
      ResponseBodyTooLargeError,
    );
  });

  it("rejects an oversized chunked body that declares no Content-Length", async () => {
    const chunk = new Uint8Array(32).fill(97);
    const response = streamed([chunk, chunk, chunk]);
    expect(response.headers.get("content-length")).toBeNull();
    await expect(readLimitedText(response, 64)).rejects.toThrow(ResponseBodyTooLargeError);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const euro = new TextEncoder().encode("€");
    const response = streamed([euro.slice(0, 1), euro.slice(1)]);
    await expect(readLimitedText(response, 64)).resolves.toBe("€");
  });

  it("returns an empty string for a bodyless response", async () => {
    const response = new Response(null, { status: 204 });
    expect(response.body).toBeNull();
    await expect(readLimitedText(response, 64)).resolves.toBe("");
  });

  it("bounds control-plane responses at 1 MiB", () => {
    expect(MAX_CONTROL_PLANE_RESPONSE_BYTES).toBe(1024 * 1024);
  });
});
