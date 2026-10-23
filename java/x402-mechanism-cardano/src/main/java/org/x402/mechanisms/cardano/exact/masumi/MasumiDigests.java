package org.x402.mechanisms.cardano.exact.masumi;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.Jcs;

/**
 * The two Masumi digests: {@code inputHash} over the
 * content-free commitment manifest, and {@code termsDigest} over the signed terms. Both are
 * {@code SHA-256(UTF-8(domain) || UTF-8(JCS(value)))} as lowercase hex.
 */
public final class MasumiDigests {

  private static final String INPUT_HASH_DOMAIN = "masumi:x402:input:v1\n";
  private static final String TERMS_DIGEST_DOMAIN = "masumi:x402:terms:v1\n";
  private static final Pattern BASE64URL = Pattern.compile("^[A-Za-z0-9_-]*$");

  private MasumiDigests() {}

  private static String sha256Hex(byte[]... parts) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      for (byte[] part : parts) {
        digest.update(part);
      }
      return HexFormat.of().formatHex(digest.digest());
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  private static String domainDigest(String domain, Object value) {
    return sha256Hex(
        domain.getBytes(StandardCharsets.UTF_8), Jcs.canonicalize(value).getBytes(StandardCharsets.UTF_8));
  }

  /**
   * The bytes a commitment part's digest covers: UTF-8 of JCS for {@code jcs}, base64url-decoded
   * content for {@code raw}.
   *
   * @param canonicalization {@code jcs} or {@code raw}
   * @param content the content
   * @param hasContent whether content is present at all
   * @return the part bytes
   * @throws IllegalArgumentException when absent or malformed
   */
  public static byte[] commitmentPartBytes(String canonicalization, Object content, boolean hasContent) {
    if (!hasContent) {
      throw new IllegalArgumentException("Commitment part carries no content to digest");
    }
    if ("raw".equals(canonicalization)) {
      if (!(content instanceof String s)) {
        throw new IllegalArgumentException("Commitment raw content must be an unpadded base64url string");
      }
      if (!BASE64URL.matcher(s).matches()) {
        throw new IllegalArgumentException("Commitment raw content is not unpadded base64url");
      }
      byte[] decoded;
      try {
        decoded = Base64.getUrlDecoder().decode(s);
      } catch (IllegalArgumentException e) {
        throw new IllegalArgumentException("Commitment raw content is not canonical unpadded base64url", e);
      }
      if (!Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(s)) {
        throw new IllegalArgumentException("Commitment raw content is not canonical unpadded base64url");
      }
      return decoded;
    }
    return Jcs.canonicalize(content).getBytes(StandardCharsets.UTF_8);
  }

  /**
   * Lowercase hex SHA-256 of a part's bytes (content present).
   *
   * @param canonicalization {@code jcs} or {@code raw}
   * @param content the content
   * @return the digest
   */
  public static String commitmentPartDigest(String canonicalization, Object content) {
    return sha256Hex(commitmentPartBytes(canonicalization, content, true));
  }

  /**
   * Recomputes {@code inputCommitment.digest} from the manifest (contents and the top-level
   * digest omitted).
   *
   * @param commitment the commitment as a JSON map
   * @return the input hash
   */
  public static String computeInputHash(Map<String, ?> commitment) {
    Map<String, Object> manifest = new LinkedHashMap<>();
    manifest.put("version", commitment.get("version"));
    manifest.put("algorithm", commitment.get("algorithm"));
    List<Object> parts = new ArrayList<>();
    Object rawParts = commitment.get("parts");
    if (rawParts instanceof List<?> list) {
      for (Object p : list) {
        Map<?, ?> part = (Map<?, ?>) p;
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("name", part.get("name"));
        entry.put("canonicalization", part.get("canonicalization"));
        if (part.get("mediaType") != null) {
          entry.put("mediaType", part.get("mediaType"));
        }
        entry.put("digest", part.get("digest"));
        parts.add(entry);
      }
    }
    manifest.put("parts", parts);
    return domainDigest(INPUT_HASH_DOMAIN, manifest);
  }

  /**
   * Recomputes {@code inputCommitment.digest} of a validated commitment.
   *
   * @param commitment the commitment
   * @return the input hash
   */
  public static String computeInputHash(MasumiInputCommitment commitment) {
    return computeInputHash(commitment.toJson());
  }

  /**
   * The signed terms: {@code terms} spread verbatim plus the seven projected requirement fields
   * Unknown keys of raw terms are kept, as a JavaScript object spread keeps them.
   *
   * @param terms the terms as a JSON map (a non-map counts as empty, like a JS spread)
   * @param assetTransferMethod {@code extra.assetTransferMethod}
   * @param requirements the requirements
   * @return the signed terms
   */
  public static Map<String, Object> buildSignedTerms(
      Object terms, Object assetTransferMethod, PaymentRequirements requirements) {
    Map<String, Object> signed = new LinkedHashMap<>();
    if (terms instanceof Map<?, ?> map) {
      for (Map.Entry<?, ?> e : map.entrySet()) {
        signed.put(String.valueOf(e.getKey()), e.getValue());
      }
    }
    signed.put("scheme", requirements.scheme());
    signed.put("assetTransferMethod", assetTransferMethod);
    signed.put("network", requirements.network());
    signed.put("contractAddress", requirements.payTo());
    signed.put("amount", requirements.amount());
    signed.put("asset", requirements.asset());
    signed.put("maxTimeoutSeconds", requirements.maxTimeoutSeconds());
    return signed;
  }

  /**
   * The signed terms of a validated extra.
   *
   * @param extra the validated extra
   * @param requirements the requirements
   * @return the signed terms
   */
  public static Map<String, Object> buildSignedTerms(MasumiExtra extra, PaymentRequirements requirements) {
    return buildSignedTerms(extra.terms().toJson(), MasumiExtra.ASSET_TRANSFER_METHOD, requirements);
  }

  /**
   * The signed terms read straight from {@code requirements.extra}, without validating its shape.
   *
   * @param requirements the requirements
   * @return the signed terms
   */
  public static Map<String, Object> buildSignedTerms(PaymentRequirements requirements) {
    Map<String, Object> extra = requirements.extra();
    return buildSignedTerms(extra.get("terms"), extra.get("assetTransferMethod"), requirements);
  }

  /**
   * {@code termsDigest} of signed terms.
   *
   * @param signedTerms the signed terms
   * @return lowercase hex digest
   */
  public static String computeTermsDigest(Map<String, ?> signedTerms) {
    return domainDigest(TERMS_DIGEST_DOMAIN, signedTerms);
  }

  /**
   * {@code termsDigest} of Masumi requirements, from the raw extra.
   *
   * @param requirements the requirements
   * @return lowercase hex digest
   */
  public static String termsDigest(PaymentRequirements requirements) {
    return computeTermsDigest(buildSignedTerms(requirements));
  }
}
