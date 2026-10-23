import type { HttpPaymentCall } from "@x402/core/types";

/**
 * Returns the reason an aborted signal carries, or a standard AbortError.
 *
 * @param signal - An aborted signal
 * @returns The abort reason
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Reads a body stream to the end. Rejects as soon as the signal aborts, also
 * while a read is pending, and cancels the stream so its source stops. The
 * abort is checked again after every read, so a source that ends its own stream
 * when aborted cannot make a partial body look complete.
 *
 * @param stream - The body stream
 * @param signal - Aborts the read
 * @returns The body bytes
 */
async function readStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw abortReason(signal);

  const reader = stream.getReader();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(abortReason(signal));
      reader.cancel(abortReason(signal)).catch(() => undefined);
    };
  });
  aborted.catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw abortReason(signal);
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Describes a fetch request as the call a payment is created for.
 *
 * Method, URL and headers are captured now, before any payment header is
 * added. The body is not touched until a consumer calls `getBody`: only then is
 * `bodySource` invoked to obtain a request whose body can be consumed, so a
 * client whose schemes never bind the body pays no extra clone or read.
 *
 * All consumers share one read, with the contract documented on
 * `HttpPaymentCall.getBody`: a signal that is already aborted rejects only its
 * own call and leaves a read in progress running; a signal that aborts while
 * the read is in progress (or the request's own signal) cancels it for every
 * waiting consumer; a cancelled or failed read stays failed rather than being
 * retried on a partially consumed stream; completed bytes are kept, and each
 * call receives its own copy.
 *
 * @param request - The original request
 * @param bodySource - Returns a request whose body may be consumed
 * @returns The HTTP payment call
 */
export function httpPaymentCall(request: Request, bodySource: () => Request): HttpPaymentCall {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });

  const call: HttpPaymentCall = { kind: "http", method: request.method, url: request.url, headers };
  if (request.body === null) return call;

  let read: Promise<Uint8Array> | undefined;
  let pending = false;
  const cancel = new AbortController();
  const unlink: Array<() => void> = [];

  /**
   * Lets a signal cancel the shared read while it is pending.
   *
   * @param signal - Signal to follow
   */
  const follow = (signal: AbortSignal): void => {
    if (signal.aborted) {
      cancel.abort(abortReason(signal));
      return;
    }
    const onAbort = () => cancel.abort(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    unlink.push(() => signal.removeEventListener("abort", onAbort));
  };

  call.getBody = (signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!read) {
      pending = true;
      follow(request.signal);
      read = (async () => {
        if (cancel.signal.aborted) throw abortReason(cancel.signal);
        const source = bodySource();
        if (source.bodyUsed) throw new Error("request_body_already_used");
        if (source.body === null) return new Uint8Array(0);
        return readStream(source.body, cancel.signal);
      })().finally(() => {
        pending = false;
        for (const remove of unlink.splice(0)) remove();
      });
      read.catch(() => undefined);
    }
    if (signal && pending) follow(signal);
    return read.then(bytes => bytes.slice());
  };
  return call;
}
