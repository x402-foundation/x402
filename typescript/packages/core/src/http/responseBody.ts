/**
 * Bounds the facilitator responses buffered by x402 clients. Control-plane JSON
 * is small, so a tight limit is enough.
 */
export const MAX_CONTROL_PLANE_RESPONSE_BYTES = 1 << 20;

/** Raised when a response body exceeds the buffering limit applied by x402 clients. */
export class ResponseBodyTooLargeError extends Error {
  /**
   * Builds the error for a body that exceeded the client's buffering limit.
   *
   * @param limit - The byte limit the body exceeded
   */
  constructor(limit: number) {
    super(`http response body too large: limit ${limit} bytes`);
    this.name = "ResponseBodyTooLargeError";
  }
}

/**
 * Reads a response body as text, stopping once it exceeds `limit` bytes.
 *
 * A body over the limit throws ResponseBodyTooLargeError and cancels the stream
 * rather than buffering the rest. Bodyless responses have nothing to bound.
 *
 * @param response - The response whose body is read
 * @param limit - Maximum number of bytes to buffer
 * @returns The decoded body text
 */
export async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ResponseBodyTooLargeError(limit);
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}
