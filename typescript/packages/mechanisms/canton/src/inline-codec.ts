/* ════════════════════════════════════════════════════════════════════════
 * INLINE PAYLOAD CODEC — gzip framing for the Canton `exact` scheme.
 *
 * The merged scheme carries the payer's signed prepared transaction INLINE and
 * gzip-compressed, so any facilitator can relay it and holds no state. Measured
 * on mainnet: ~22-27 KB raw, ~4.4-5.4 KB gzipped — the difference between "does
 * not fit a header" and "does".
 *
 * That means attacker-controlled compressed bytes reach the facilitator BEFORE
 * anything is validated, so decoding is itself an attack surface. The scheme is
 * normative about the shape of the defence:
 *
 *   "The input MUST be exactly one gzip member: reject trailing bytes after the
 *    member and concatenated members, and reject the optional filename /
 *    comment / extra header fields."
 *
 *   "Decompress incrementally and abort as soon as either bound is exceeded: a
 *    compressed-size cap (RECOMMENDED ~8 KiB of gzip data) and a
 *    decompressed-size cap (RECOMMENDED ~64 KiB). Never allocate the output up
 *    front from a declared size."
 *
 * The bounding is mandatory; the two numbers are RECOMMENDED, so they are
 * options with those defaults rather than constants.
 *
 * WHY WE FRAME BY HAND instead of calling gunzip. Node's gunzip decodes
 * CONCATENATED members transparently and silently discards trailing bytes —
 * exactly the two shapes the scheme tells us to reject, and it would accept
 * both without a word. So we parse the 10-byte header ourselves, inflate only
 * the raw deflate body, and verify the member's own CRC32/ISIZE trailer. Any
 * appended byte or differing second member lands inside the range we inflate,
 * which makes the trailer disagree — rejected by construction. The one case a
 * trailer cannot catch is a member concatenated with an identical copy of
 * itself (its trailer agrees by definition); that one is caught by scanning
 * for the seam, see below.
 *
 * There is exactly ONE decompression here, under exactly one bound. An earlier
 * draft cross-checked the result against a second, full gunzip decode; mutation
 * testing showed that second decode's own cap silently stood in for the first
 * one, so removing the primary bound broke nothing visible — a bomb was still
 * refused, but only after being fully allocated. Redundant guards that mask
 * each other are worse than one guard that is provably load-bearing.
 *
 * ISIZE is verified, never trusted: it is compared against what we actually
 * produced, and is never used to size an allocation.
 * ════════════════════════════════════════════════════════════════════════ */
import { crc32, inflateRawSync, gzipSync } from "node:zlib";

/** Thrown for any malformed / out-of-bounds inline payload. Callers map this to
 *  the scheme's `invalid_exact_canton_malformed_payload`. Deliberately one
 *  error type with a terse reason: a caller must not turn our internal detail
 *  into a probing oracle for whoever supplied the bytes. */
export class InlineCodecError extends Error {
  /**
   *
   * @param reason
   */
  constructor(reason: string) {
    super(`inline payload rejected: ${reason}`);
    this.name = "InlineCodecError";
  }
}

/** RECOMMENDED caps from the scheme. Overridable — the scheme mandates that
 *  bounds exist, not these exact numbers. */
export const DEFAULT_MAX_COMPRESSED_BYTES = 8 * 1024;
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * 1024;

export interface InlineDecodeOptions {
  /** Cap on the gzip member itself, before any work is done. */
  maxCompressedBytes?: number;
  /** Cap on what inflating may produce. Enforced by the inflater, which stops
   *  and throws at the bound rather than allocating to fit. */
  maxDecompressedBytes?: number;
}

const GZIP_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
/** FLG bit 2 FEXTRA, bit 3 FNAME, bit 4 FCOMMENT — all rejected by the scheme.
 *  Bits 5-7 are reserved and MUST be zero per RFC 1952. FHCRC (bit 1) is also
 *  rejected: it would shift the body start, and no honest producer sets it. */
const FLG_REJECT_MASK = 0b1111_1110;

/**
 * True when zlib stopped because it hit `maxOutputLength`.
 *
 * @param err
 */
function isOverLengthError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

/** Compress prepared-transaction bytes for inline carriage.
 *  `mtime: 0` and no filename keep the output deterministic and free of the
 *
 * @param raw
 *  - optional header fields the decoder refuses. */
export function encodeInlinePayload(raw: Uint8Array): Buffer {
  return gzipSync(raw, { level: 9 });
}

/**
 * Decode one inline gzip member back to the prepared-transaction bytes.
 * Throws `InlineCodecError` on anything that is not exactly one clean member
 * within both bounds. Never returns partially-decoded output.
 *
 * @param input
 * @param opts
 */
export function decodeInlinePayload(input: Uint8Array, opts: InlineDecodeOptions = {}): Buffer {
  const maxCompressed = opts.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES;
  const maxDecompressed = opts.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;

  // Compressed cap first: refuse before spending any work on the bytes.
  if (input.length > maxCompressed) {
    throw new InlineCodecError(
      `compressed size ${input.length} exceeds the ${maxCompressed}-byte cap`,
    );
  }
  if (input.length < GZIP_HEADER_BYTES + GZIP_TRAILER_BYTES) {
    throw new InlineCodecError("too short to be a gzip member");
  }

  const buf = Buffer.from(input.buffer, input.byteOffset, input.length);
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new InlineCodecError("not a gzip member (bad magic)");
  }
  if (buf[2] !== 0x08) {
    throw new InlineCodecError("unsupported compression method");
  }
  // Reject FEXTRA / FNAME / FCOMMENT / FHCRC / reserved in one mask. Only FTEXT
  // (bit 0) may be set, and it carries no length, so the body always starts at
  // a fixed offset — no attacker-controlled header length to walk.
  if ((buf[3] as number) & FLG_REJECT_MASK) {
    throw new InlineCodecError("gzip header carries disallowed optional fields");
  }

  const body = buf.subarray(GZIP_HEADER_BYTES, buf.length - GZIP_TRAILER_BYTES);
  const trailer = buf.subarray(buf.length - GZIP_TRAILER_BYTES);

  let out: Buffer;
  try {
    // maxOutputLength makes the inflater stop AT the bound and throw, instead
    // of growing to fit — this is the decompression-bomb defence. The declared
    // ISIZE is not consulted here at all.
    out = inflateRawSync(body, { maxOutputLength: maxDecompressed });
  } catch (err) {
    // Classify on the error CODE, not its message: hitting maxOutputLength
    // raises ERR_BUFFER_TOO_LARGE with the text "Cannot create a Buffer larger
    // than N bytes", which does not read as a size-cap breach and would get
    // mislabelled as a malformed archive.
    throw new InlineCodecError(
      isOverLengthError(err)
        ? `decompressed size exceeds the ${maxDecompressed}-byte cap`
        : "not a single well-formed gzip member",
    );
  }

  // Verify the member's own trailer against what we actually produced. This is
  // what makes concatenated members and trailing bytes fail: their extra bytes
  // were inflated as part of the body, so the CRC and length cannot agree.
  const expectedCrc = trailer.readUInt32LE(0);
  const expectedSize = trailer.readUInt32LE(4);
  if (out.length !== expectedSize) {
    throw new InlineCodecError("gzip trailer length does not match the output");
  }
  if (crc32(out) >>> 0 !== expectedCrc) {
    throw new InlineCodecError("gzip trailer checksum does not match the output");
  }

  // The trailer check above catches concatenation only when the members
  // DIFFER; two copies of the same member produce a trailer that agrees with
  // the first member's output and would otherwise slip through.
  //
  // Deliberately NOT done by decoding again with gunzip (which reads every
  // member) and comparing lengths: that would decompress the payload a second
  // time, and its own cap would then mask a missing cap on the inflate above —
  // a bomb would still be refused, but only after being fully allocated. One
  // decompression, one bound. So the second member is found structurally
  // instead: its magic is preceded by the first member's own trailer.
  const seam = Buffer.alloc(10);
  seam.writeUInt32LE(expectedCrc, 0);
  seam.writeUInt32LE(expectedSize, 4);
  seam[8] = 0x1f;
  seam[9] = 0x8b;
  if (body.includes(seam)) {
    throw new InlineCodecError("input carries more than one gzip member");
  }
  return out;
}
