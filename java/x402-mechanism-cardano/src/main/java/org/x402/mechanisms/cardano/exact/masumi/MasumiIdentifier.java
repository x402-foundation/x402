package org.x402.mechanisms.cardano.exact.masumi;

import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * The Masumi compatibility identifier: five
 * period-delimited text segments, LZString-compressed, as lowercase hex.
 */
public final class MasumiIdentifier {

  private static final int SELLER_NONCE_HEX_LENGTH = 64;
  private static final Pattern LOWER_HEX = Pattern.compile("^[0-9a-f]+$");

  private MasumiIdentifier() {}

  /**
   * The identifier segments.
   *
   * @param sellerNonce 64 hex characters
   * @param agentIdentifier registry asset id, or empty
   * @param buyerNonce buyer nonce, possibly empty
   * @param referenceSignature COSE_Sign1 hex
   * @param referenceKey COSE_Key hex
   * @param contractAddress bech32 escrow address
   */
  public record Parts(
      String sellerNonce,
      String agentIdentifier,
      String buyerNonce,
      String referenceSignature,
      String referenceKey,
      String contractAddress) {}

  /**
   * The exact identifier text.
   *
   * @param parts the segments
   * @return the text
   */
  public static String buildText(Parts parts) {
    return String.join(
        ".",
        parts.sellerNonce() + parts.agentIdentifier(),
        parts.buyerNonce(),
        parts.referenceSignature(),
        parts.referenceKey(),
        parts.contractAddress());
  }

  /**
   * Encodes the wire {@code blockchainIdentifier}.
   *
   * @param parts the segments
   * @return lowercase hex of the compressed text
   * @throws IllegalArgumentException when over the size limits
   */
  public static String encode(Parts parts) {
    String text = buildText(parts);
    if (text.length() > MasumiConstants.MAX_IDENTIFIER_TEXT_CHARS) {
      throw new IllegalArgumentException("Masumi identifier text exceeds the character limit");
    }
    byte[] compressed = LzString.compressToUint8Array(text);
    if (compressed.length > MasumiConstants.MAX_IDENTIFIER_COMPRESSED_BYTES) {
      throw new IllegalArgumentException("Masumi identifier exceeds the compressed byte limit");
    }
    return HexFormat.of().formatHex(compressed);
  }

  /**
   * Decodes a wire {@code blockchainIdentifier}.
   *
   * @param blockchainIdentifier lowercase hex
   * @return the segments, or {@code null} when it does not decode to five segments
   */
  public static Parts decode(String blockchainIdentifier) {
    if (blockchainIdentifier == null
        || blockchainIdentifier.isEmpty()
        || blockchainIdentifier.length() % 2 != 0
        || blockchainIdentifier.length() / 2 > MasumiConstants.MAX_IDENTIFIER_COMPRESSED_BYTES
        || !LOWER_HEX.matcher(blockchainIdentifier).matches()) {
      return null;
    }
    String text =
        LzString.decompressBounded(
            HexFormat.of().parseHex(blockchainIdentifier), MasumiConstants.MAX_IDENTIFIER_TEXT_CHARS);
    if (text == null || text.length() > MasumiConstants.MAX_IDENTIFIER_TEXT_CHARS) {
      return null;
    }
    String[] segments = text.split("\\.", -1);
    if (segments.length != 5 || segments[0].length() < SELLER_NONCE_HEX_LENGTH) {
      return null;
    }
    return new Parts(
        segments[0].substring(0, SELLER_NONCE_HEX_LENGTH),
        segments[0].substring(SELLER_NONCE_HEX_LENGTH),
        segments[1],
        segments[2],
        segments[3],
        segments[4]);
  }
}
