package org.x402.mechanisms.cardano.exact.masumi;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoPolicies;

/**
 * Closed-object wire schema of the Masumi {@code extra} block,
 * with a specific rejection detail for each failure. Structure only: digests, signatures, the
 * escrow address and the
 * datum are verified separately.
 */
public final class MasumiSchema {

  private static final Set<String> EXTRA_KEYS =
      Set.of(
          "assetTransferMethod",
          "confirmationPolicy",
          "areFeesSponsored",
          "inputCommitment",
          "terms",
          "referenceKey",
          "referenceSignature",
          "blockchainIdentifier",
          "deployment");
  private static final Set<String> COMMITMENT_KEYS = Set.of("version", "algorithm", "parts", "digest");
  private static final Set<String> PART_KEYS = Set.of("name", "canonicalization", "mediaType", "content", "digest");
  private static final Set<String> TERMS_KEYS =
      Set.of(
          "version",
          "paymentType",
          "sellerAddress",
          "sellerReturnAddress",
          "sellerNonce",
          "buyerNonce",
          "agentIdentifier",
          "inputHash",
          "payByTime",
          "submitResultTime",
          "unlockTime",
          "externalDisputeUnlockTime");
  private static final Set<String> DEPLOYMENT_KEYS = Set.of("requiredAdmins", "adminVkeys", "cooldownPeriod");

  private static final Pattern HEX = Pattern.compile("^([0-9a-f]{2})*$");
  private static final Pattern HEX_32_BYTES = Pattern.compile("^[0-9a-f]{64}$");
  private static final Pattern HEX_28_BYTES = Pattern.compile("^[0-9a-f]{56}$");
  private static final Pattern POSITIVE_INT = Pattern.compile("^[1-9][0-9]*$");
  private static final Pattern NON_NEGATIVE_INT = Pattern.compile("^(0|[1-9][0-9]*)$");
  private static final Pattern BASE64URL = Pattern.compile("^[A-Za-z0-9_-]*$");
  private static final int MAX_JSON_DEPTH = 64;
  private static final int MAX_JSON_VALUES = 100_000;
  private static final int MAX_PART_NAME_CHARS = 128;
  private static final int MAX_MEDIA_TYPE_CHARS = 256;
  private static final int MAX_POSIX_DIGITS = 20;
  private static final int MAX_AGENT_IDENTIFIER_HEX_CHARS = 120;

  private MasumiSchema() {}

  /**
   * The validation outcome.
   *
   * @param ok whether the block is valid
   * @param extra the typed block when valid
   * @param detail the rejection detail when invalid
   */
  public record Result(boolean ok, MasumiExtra extra, String detail) {
    static Result fail(String detail) {
      return new Result(false, null, detail);
    }
  }

  private static final class Rejection extends RuntimeException {
    private static final long serialVersionUID = 1L;

    Rejection(String detail) {
      super(detail, null, false, false);
    }
  }

  /**
   * Validates a Masumi {@code extra} block against the wire schema.
   *
   * @param value the raw {@code requirements.extra}
   * @param network the x402 Cardano network
   * @return the typed block or the rejection detail
   */
  public static Result validate(Object value, String network) {
    try {
      return new Result(true, validateExtra(value, network), null);
    } catch (Rejection r) {
      return Result.fail(r.getMessage());
    }
  }

  /**
   * Whether a value is a canonical positive POSIX-ms decimal string of at most 20 digits.
   *
   * @param value the candidate
   * @return true when it converts cleanly
   */
  public static boolean isPosixMsString(Object value) {
    return value instanceof String s && s.length() <= MAX_POSIX_DIGITS && POSITIVE_INT.matcher(s).matches();
  }

  private static Map<?, ?> record(Object value, String detail) {
    if (!(value instanceof Map<?, ?> map)) {
      throw new Rejection(detail);
    }
    return map;
  }

  private static void closed(Map<?, ?> value, Set<String> allowed, String prefix) {
    for (Object key : value.keySet()) {
      if (!allowed.contains(String.valueOf(key))) {
        throw new Rejection(prefix + " has unknown field " + key);
      }
    }
  }

  private static MasumiExtra validateExtra(Object raw, String network) {
    Map<?, ?> value = record(raw, "extra must be an object");
    closed(value, EXTRA_KEYS, "extra");
    if (!"masumi".equals(value.get("assetTransferMethod"))) {
      throw new Rejection("extra.assetTransferMethod must be masumi");
    }
    if (value.containsKey("confirmationPolicy") && CardanoPolicies.normalize(value.get("confirmationPolicy")) == null) {
      throw new Rejection("extra.confirmationPolicy must be { l1Confirmations: -1..20 }");
    }
    if (value.containsKey("areFeesSponsored") && !Boolean.FALSE.equals(value.get("areFeesSponsored"))) {
      throw new Rejection("extra.areFeesSponsored must be false");
    }
    for (String field : List.of("referenceKey", "referenceSignature", "blockchainIdentifier")) {
      Object hex = value.get(field);
      int maxBytes =
          "blockchainIdentifier".equals(field)
              ? MasumiConstants.MAX_IDENTIFIER_COMPRESSED_BYTES
              : MasumiConstants.MAX_COSE_BYTES;
      if (!(hex instanceof String s) || s.isEmpty() || s.length() / 2 > maxBytes || !HEX.matcher(s).matches()) {
        throw new Rejection("extra." + field + " must be non-empty lowercase even-length hex");
      }
    }
    MasumiInputCommitment commitment = validateCommitment(value.get("inputCommitment"));
    MasumiTerms terms = validateTerms(value.get("terms"), network, commitment.digest());
    MasumiDeployment deployment = null;
    if (value.containsKey("deployment")) {
      deployment = validateDeployment(value.get("deployment"));
    }
    return new MasumiExtra(
        value.containsKey("confirmationPolicy") ? value.get("confirmationPolicy") : null,
        value.containsKey("areFeesSponsored") ? Boolean.FALSE : null,
        commitment,
        terms,
        (String) value.get("referenceKey"),
        (String) value.get("referenceSignature"),
        (String) value.get("blockchainIdentifier"),
        deployment);
  }

  private static MasumiDeployment validateDeployment(Object raw) {
    Map<?, ?> value = record(raw, "deployment must be an object");
    closed(value, DEPLOYMENT_KEYS, "deployment");
    Object admins = value.get("adminVkeys");
    if (!(admins instanceof List<?> list) || list.isEmpty() || list.size() > MasumiConstants.MAX_ADMIN_KEYS) {
      throw new Rejection("deployment.adminVkeys must be a non-empty array");
    }
    List<String> vkeys = new ArrayList<>();
    for (Object vkey : list) {
      if (!(vkey instanceof String s) || !HEX_28_BYTES.matcher(s).matches()) {
        throw new Rejection("deployment.adminVkeys must be 28-byte lowercase hex");
      }
      vkeys.add(s);
    }
    Object required = value.get("requiredAdmins");
    if (!(required instanceof String r) || r.length() > 3 || !POSITIVE_INT.matcher(r).matches()) {
      throw new Rejection("deployment.requiredAdmins must be a positive integer string");
    }
    if (new BigInteger(r).compareTo(BigInteger.valueOf(vkeys.size())) > 0) {
      throw new Rejection("deployment.requiredAdmins exceeds adminVkeys length");
    }
    Object cooldown = value.get("cooldownPeriod");
    if (!(cooldown instanceof String c) || c.length() > MAX_POSIX_DIGITS || !NON_NEGATIVE_INT.matcher(c).matches()) {
      throw new Rejection("deployment.cooldownPeriod must be a non-negative integer string");
    }
    return new MasumiDeployment(r, vkeys, c);
  }

  private static MasumiCommitmentPart validatePart(Object raw, int index) {
    String at = "parts[" + index + "]";
    Map<?, ?> value = record(raw, at + " must be an object");
    closed(value, PART_KEYS, at);
    Object name = value.get("name");
    if (!(name instanceof String n) || n.isEmpty() || n.length() > MAX_PART_NAME_CHARS) {
      throw new Rejection(at + ".name must be a non-empty string");
    }
    Object canonicalization = value.get("canonicalization");
    if (!"jcs".equals(canonicalization) && !"raw".equals(canonicalization)) {
      throw new Rejection(at + ".canonicalization must be jcs or raw");
    }
    Object mediaType = value.get("mediaType");
    if (value.containsKey("mediaType")
        && (!(mediaType instanceof String m) || m.length() > MAX_MEDIA_TYPE_CHARS)) {
      throw new Rejection(at + ".mediaType must be a string");
    }
    Object digest = value.get("digest");
    if (!(digest instanceof String d) || !HEX_32_BYTES.matcher(d).matches()) {
      throw new Rejection(at + ".digest must be 32-byte lowercase hex");
    }
    boolean hasContent = value.containsKey("content");
    if (hasContent) {
      String error = contentError(value.get("content"), (String) canonicalization);
      if (error != null) {
        throw new Rejection(at + ".content " + error);
      }
    }
    return new MasumiCommitmentPart(
        n, (String) canonicalization, (String) mediaType, hasContent, value.get("content"), d);
  }

  /**
   * Checks one commitment payload against the content budget before it is canonicalized.
   *
   * @param value the content
   * @param canonicalization {@code jcs} or {@code raw}
   * @return the rejection detail, or {@code null} when within budget
   */
  static String contentError(Object value, String canonicalization) {
    if ("raw".equals(canonicalization)) {
      if (!(value instanceof String s) || !BASE64URL.matcher(s).matches()) {
        return "raw content must be canonical unpadded base64url";
      }
      byte[] decoded;
      try {
        decoded = Base64.getUrlDecoder().decode(s);
      } catch (IllegalArgumentException e) {
        return "raw content exceeds the byte limit or is not canonical base64url";
      }
      if (decoded.length > MasumiConstants.MAX_COMMITMENT_CONTENT_BYTES
          || !Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(s)) {
        return "raw content exceeds the byte limit or is not canonical base64url";
      }
      return null;
    }
    Deque<Object[]> pending = new ArrayDeque<>();
    pending.push(new Object[] {value, 0});
    int values = 0;
    long bytes = 0;
    while (!pending.isEmpty()) {
      Object[] current = pending.pop();
      Object item = current[0];
      int depth = (Integer) current[1];
      values++;
      if (values > MAX_JSON_VALUES) {
        return "JCS content exceeds the value limit";
      }
      if (depth > MAX_JSON_DEPTH) {
        return "JCS content exceeds the nesting limit";
      }
      if (item == null || item instanceof Boolean) {
        continue;
      }
      if (item instanceof Number n) {
        if (!Double.isFinite(n.doubleValue())) {
          return "JCS content contains a non-finite number";
        }
        continue;
      }
      if (item instanceof String s) {
        bytes += s.getBytes(StandardCharsets.UTF_8).length;
        if (bytes > MasumiConstants.MAX_COMMITMENT_CONTENT_BYTES) {
          return "JCS content exceeds the byte limit";
        }
        continue;
      }
      if (item instanceof List<?> list) {
        for (Object child : list) {
          pending.push(new Object[] {child, depth + 1});
        }
        continue;
      }
      if (!(item instanceof Map<?, ?> map)) {
        return "JCS content must contain only plain JSON objects";
      }
      for (Map.Entry<?, ?> e : map.entrySet()) {
        bytes += String.valueOf(e.getKey()).getBytes(StandardCharsets.UTF_8).length;
        if (bytes > MasumiConstants.MAX_COMMITMENT_CONTENT_BYTES) {
          return "JCS content exceeds the byte limit";
        }
        pending.push(new Object[] {e.getValue(), depth + 1});
      }
    }
    return null;
  }

  private static MasumiInputCommitment validateCommitment(Object raw) {
    Map<?, ?> value = record(raw, "inputCommitment must be an object");
    closed(value, COMMITMENT_KEYS, "inputCommitment");
    if (!"1".equals(value.get("version"))) {
      throw new Rejection("inputCommitment.version must be '1'");
    }
    if (!"sha256".equals(value.get("algorithm"))) {
      throw new Rejection("inputCommitment.algorithm must be 'sha256'");
    }
    Object digest = value.get("digest");
    if (!(digest instanceof String d) || !HEX_32_BYTES.matcher(d).matches()) {
      throw new Rejection("inputCommitment.digest must be 32-byte lowercase hex");
    }
    Object parts = value.get("parts");
    if (!(parts instanceof List<?> list) || list.isEmpty() || list.size() > MasumiConstants.MAX_COMMITMENT_PARTS) {
      throw new Rejection("inputCommitment.parts must be a non-empty array");
    }
    List<MasumiCommitmentPart> result = new ArrayList<>();
    Set<String> names = new HashSet<>();
    for (int i = 0; i < list.size(); i++) {
      MasumiCommitmentPart part = validatePart(list.get(i), i);
      if (!names.add(part.name())) {
        throw new Rejection("inputCommitment has duplicate part name " + part.name());
      }
      result.add(part);
    }
    return new MasumiInputCommitment("1", "sha256", result, d);
  }

  private static MasumiTerms validateTerms(Object raw, String network, String commitmentDigest) {
    Map<?, ?> value = record(raw, "terms must be an object");
    closed(value, TERMS_KEYS, "terms");
    if (!"1".equals(value.get("version"))) {
      throw new Rejection("terms.version must be '1'");
    }
    if (!MasumiConstants.PAYMENT_SOURCE_TYPE.equals(value.get("paymentType"))) {
      throw new Rejection("terms.paymentType must be " + MasumiConstants.PAYMENT_SOURCE_TYPE);
    }
    if (!CardanoAddresses.isKeyCredentialAddressOn(value.get("sellerAddress"), network)) {
      throw new Rejection("terms.sellerAddress must be a key-credential address on network");
    }
    if (value.containsKey("sellerReturnAddress")
        && !CardanoAddresses.isKeyCredentialAddressOn(value.get("sellerReturnAddress"), network)) {
      throw new Rejection("terms.sellerReturnAddress must be a key-credential address on network");
    }
    Object sellerNonce = value.get("sellerNonce");
    if (!(sellerNonce instanceof String sn) || !HEX_32_BYTES.matcher(sn).matches()) {
      throw new Rejection("terms.sellerNonce must be 32-byte lowercase hex");
    }
    Object buyerNonce = value.get("buyerNonce");
    if (!(buyerNonce instanceof String bn)
        || !HEX.matcher(bn).matches()
        || (!bn.isEmpty() && (bn.length() < 14 || bn.length() > 26))) {
      throw new Rejection("terms.buyerNonce must be empty or 14-26 lowercase hex chars");
    }
    Object agent = value.get("agentIdentifier");
    if (value.containsKey("agentIdentifier")
        && agent != null
        && (!(agent instanceof String a)
            || a.length() > MAX_AGENT_IDENTIFIER_HEX_CHARS
            || !HEX.matcher(a).matches())) {
      throw new Rejection("terms.agentIdentifier must be null or lowercase hex");
    }
    if (!commitmentDigest.equals(value.get("inputHash"))) {
      throw new Rejection("terms.inputHash must equal inputCommitment.digest");
    }
    for (String field : List.of("payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime")) {
      if (!isPosixMsString(value.get(field))) {
        throw new Rejection("terms." + field + " must be a positive POSIX-ms integer string");
      }
    }
    return new MasumiTerms(
        "1",
        MasumiConstants.PAYMENT_SOURCE_TYPE,
        (String) value.get("sellerAddress"),
        value.containsKey("sellerReturnAddress") ? (String) value.get("sellerReturnAddress") : null,
        sn,
        bn,
        value.containsKey("agentIdentifier"),
        (String) agent,
        commitmentDigest,
        (String) value.get("payByTime"),
        (String) value.get("submitResultTime"),
        (String) value.get("unlockTime"),
        (String) value.get("externalDisputeUnlockTime"));
  }
}
