/**
 * Decompresses the UCS-2 byte form produced by LZString while enforcing an
 * output limit during expansion. The upstream decoder exposes only an
 * after-the-fact string result, which permits small decompression bombs.
 *
 * @param compressed - Big-endian UCS-2 bytes from `compressToUint8Array`.
 * @param maxOutputChars - Maximum UTF-16 code units to produce.
 * @returns Decoded text, or `null` for malformed or oversized input.
 */
export function decompressLzStringBounded(
  compressed: Uint8Array,
  maxOutputChars: number,
): string | null {
  if (
    compressed.length === 0 ||
    compressed.length % 2 !== 0 ||
    !Number.isSafeInteger(maxOutputChars) ||
    maxOutputChars <= 0
  ) {
    return null;
  }

  const codeUnitCount = compressed.length / 2;
  let codeUnitIndex = 0;
  let bitMask = 0x8000;

  const codeUnitAt = (index: number): number =>
    compressed[index * 2]! * 256 + compressed[index * 2 + 1]!;

  let currentCodeUnit = codeUnitAt(0);
  const readBits = (count: number): number | null => {
    let value = 0;
    let power = 1;
    for (let i = 0; i < count; i++) {
      if (codeUnitIndex >= codeUnitCount) return null;
      if ((currentCodeUnit & bitMask) !== 0) value |= power;
      power *= 2;
      bitMask >>= 1;
      if (bitMask === 0) {
        bitMask = 0x8000;
        codeUnitIndex++;
        if (codeUnitIndex < codeUnitCount) currentCodeUnit = codeUnitAt(codeUnitIndex);
      }
    }
    return value;
  };

  const dictionary: Array<string | undefined> = [undefined, undefined, undefined];
  let enlargeIn = 4;
  let dictionarySize = 4;
  let bitsPerCode = 3;

  const initialKind = readBits(2);
  if (initialKind === null || initialKind === 2) return initialKind === 2 ? "" : null;
  const initialValue = readBits(initialKind === 0 ? 8 : 16);
  if (initialValue === null) return null;

  let previous = String.fromCharCode(initialValue);
  dictionary[3] = previous;
  let output = previous;
  if (output.length > maxOutputChars) return null;

  while (true) {
    const encoded = readBits(bitsPerCode);
    if (encoded === null) return null;
    let code = encoded;

    if (code === 0 || code === 1) {
      const literal = readBits(code === 0 ? 8 : 16);
      if (literal === null) return null;
      dictionary[dictionarySize] = String.fromCharCode(literal);
      code = dictionarySize;
      dictionarySize++;
      enlargeIn--;
    } else if (code === 2) {
      return output;
    }

    if (enlargeIn === 0) {
      enlargeIn = 2 ** bitsPerCode;
      bitsPerCode++;
    }

    let entry = dictionary[code];
    if (entry === undefined) {
      if (code !== dictionarySize) return null;
      entry = previous + previous.charAt(0);
    }
    if (output.length + entry.length > maxOutputChars) return null;
    output += entry;

    dictionary[dictionarySize] = previous + entry.charAt(0);
    dictionarySize++;
    enlargeIn--;
    previous = entry;

    if (enlargeIn === 0) {
      enlargeIn = 2 ** bitsPerCode;
      bitsPerCode++;
    }
  }
}
