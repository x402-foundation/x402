package org.x402.mechanisms.cardano.exact.masumi;

import java.math.BigInteger;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoConstants;

/**
 * Issues a Masumi {@code PaymentRequirements}: request
 * commitment, seller-signed terms, CIP-8 authorization and compatibility identifier. The issuer
 * must store the result and serve it verbatim on the paid retry.
 */
public final class MasumiIssue {

  private static final SecureRandom RANDOM = new SecureRandom();

  private MasumiIssue() {}

  /**
   * Everything needed to issue one Masumi 402.
   *
   * @param network the x402 network
   * @param asset {@code lovelace} or a canonical unit
   * @param amount positive canonical decimal
   * @param maxTimeoutSeconds the validity window
   * @param sellerAddress the seller's key-credential address
   * @param signTerms the seller's CIP-8 signer
   * @param commitment the request commitment parts
   * @param payByTime POSIX ms
   * @param submitResultTime POSIX ms
   * @param unlockTime POSIX ms
   * @param externalDisputeUnlockTime POSIX ms
   * @param sellerNonce 32 bytes hex, or {@code null} for a fresh random one
   * @param buyerNonce the buyer nonce, or {@code null} for empty
   * @param agentIdentifierPresent whether to put {@code agentIdentifier} on the wire
   * @param agentIdentifier the registry asset id (may be {@code null} when present)
   * @param sellerReturnAddress optional payout address, or {@code null}
   * @param confirmationPolicy the {@code confirmationPolicy} object, or {@code null}
   * @param deployment a non-canonical deployment, or {@code null}
   * @param unsafeSkipPolicyChecks test-only: skip the clock-relative issue policy
   * @param maxDeadlineHorizonMs the seller's horizon, or {@code null} for 30 days
   * @param clock the clock
   */
  public record Input(
      String network,
      String asset,
      String amount,
      int maxTimeoutSeconds,
      String sellerAddress,
      MasumiTermsSigner signTerms,
      List<MasumiCommitmentInput> commitment,
      String payByTime,
      String submitResultTime,
      String unlockTime,
      String externalDisputeUnlockTime,
      String sellerNonce,
      String buyerNonce,
      boolean agentIdentifierPresent,
      String agentIdentifier,
      String sellerReturnAddress,
      Object confirmationPolicy,
      MasumiDeployment deployment,
      boolean unsafeSkipPolicyChecks,
      BigInteger maxDeadlineHorizonMs,
      Clock clock) {

    /** Copies the commitment. */
    public Input {
      commitment = List.copyOf(commitment);
      clock = clock == null ? Clock.systemUTC() : clock;
    }

    /**
     * A builder.
     *
     * @return the builder
     */
    public static Builder builder() {
      return new Builder();
    }
  }

  /** Builder for {@link Input}. */
  public static final class Builder {
    private String network;
    private String asset;
    private String amount;
    private int maxTimeoutSeconds;
    private String sellerAddress;
    private MasumiTermsSigner signTerms;
    private List<MasumiCommitmentInput> commitment = List.of();
    private String payByTime;
    private String submitResultTime;
    private String unlockTime;
    private String externalDisputeUnlockTime;
    private String sellerNonce;
    private String buyerNonce;
    private boolean agentIdentifierPresent;
    private String agentIdentifier;
    private String sellerReturnAddress;
    private Object confirmationPolicy;
    private MasumiDeployment deployment;
    private boolean unsafeSkipPolicyChecks;
    private BigInteger maxDeadlineHorizonMs;
    private Clock clock;

    private Builder() {}

    /**
     * Sets the network.
     *
     * @param v the value
     * @return this builder
     */
    public Builder network(String v) {
      network = v;
      return this;
    }

    /**
     * Sets the asset.
     *
     * @param v the value
     * @return this builder
     */
    public Builder asset(String v) {
      asset = v;
      return this;
    }

    /**
     * Sets the amount.
     *
     * @param v the value
     * @return this builder
     */
    public Builder amount(String v) {
      amount = v;
      return this;
    }

    /**
     * Sets maxTimeoutSeconds.
     *
     * @param v the value
     * @return this builder
     */
    public Builder maxTimeoutSeconds(int v) {
      maxTimeoutSeconds = v;
      return this;
    }

    /**
     * Sets the seller address.
     *
     * @param v the value
     * @return this builder
     */
    public Builder sellerAddress(String v) {
      sellerAddress = v;
      return this;
    }

    /**
     * Sets the terms signer.
     *
     * @param v the value
     * @return this builder
     */
    public Builder signTerms(MasumiTermsSigner v) {
      signTerms = v;
      return this;
    }

    /**
     * Sets the commitment parts.
     *
     * @param v the value
     * @return this builder
     */
    public Builder commitment(List<MasumiCommitmentInput> v) {
      commitment = v;
      return this;
    }

    /**
     * Sets payByTime.
     *
     * @param v the value
     * @return this builder
     */
    public Builder payByTime(String v) {
      payByTime = v;
      return this;
    }

    /**
     * Sets submitResultTime.
     *
     * @param v the value
     * @return this builder
     */
    public Builder submitResultTime(String v) {
      submitResultTime = v;
      return this;
    }

    /**
     * Sets unlockTime.
     *
     * @param v the value
     * @return this builder
     */
    public Builder unlockTime(String v) {
      unlockTime = v;
      return this;
    }

    /**
     * Sets externalDisputeUnlockTime.
     *
     * @param v the value
     * @return this builder
     */
    public Builder externalDisputeUnlockTime(String v) {
      externalDisputeUnlockTime = v;
      return this;
    }

    /**
     * Sets the seller nonce.
     *
     * @param v the value
     * @return this builder
     */
    public Builder sellerNonce(String v) {
      sellerNonce = v;
      return this;
    }

    /**
     * Sets the buyer nonce.
     *
     * @param v the value
     * @return this builder
     */
    public Builder buyerNonce(String v) {
      buyerNonce = v;
      return this;
    }

    /**
     * Puts {@code agentIdentifier} on the wire ({@code null} is a distinct signed value).
     *
     * @param v the value
     * @return this builder
     */
    public Builder agentIdentifier(String v) {
      agentIdentifierPresent = true;
      agentIdentifier = v;
      return this;
    }

    /**
     * Sets the seller return address.
     *
     * @param v the value
     * @return this builder
     */
    public Builder sellerReturnAddress(String v) {
      sellerReturnAddress = v;
      return this;
    }

    /**
     * Sets the confirmation policy object.
     *
     * @param v the value
     * @return this builder
     */
    public Builder confirmationPolicy(Object v) {
      confirmationPolicy = v;
      return this;
    }

    /**
     * Sets a custom deployment.
     *
     * @param v the value
     * @return this builder
     */
    public Builder deployment(MasumiDeployment v) {
      deployment = v;
      return this;
    }

    /**
     * Test-only: skips the clock-relative issue policy.
     *
     * @param v the value
     * @return this builder
     */
    public Builder unsafeSkipPolicyChecks(boolean v) {
      unsafeSkipPolicyChecks = v;
      return this;
    }

    /**
     * Sets the seller's deadline horizon.
     *
     * @param v the value
     * @return this builder
     */
    public Builder maxDeadlineHorizonMs(BigInteger v) {
      maxDeadlineHorizonMs = v;
      return this;
    }

    /**
     * Sets the clock.
     *
     * @param v the value
     * @return this builder
     */
    public Builder clock(Clock v) {
      clock = v;
      return this;
    }

    /**
     * Builds the input.
     *
     * @return the input
     */
    public Input build() {
      return new Input(
          network, asset, amount, maxTimeoutSeconds, sellerAddress, signTerms, commitment, payByTime,
          submitResultTime, unlockTime, externalDisputeUnlockTime, sellerNonce, buyerNonce,
          agentIdentifierPresent, agentIdentifier, sellerReturnAddress, confirmationPolicy, deployment,
          unsafeSkipPolicyChecks, maxDeadlineHorizonMs, clock);
    }
  }

  private static void assertPolicy(Input input, BigInteger nowMs) {
    String[][] fields = {
      {"payByTime", input.payByTime()},
      {"submitResultTime", input.submitResultTime()},
      {"unlockTime", input.unlockTime()},
      {"externalDisputeUnlockTime", input.externalDisputeUnlockTime()},
    };
    for (String[] field : fields) {
      if (!MasumiSchema.isPosixMsString(field[1])) {
        throw new IllegalArgumentException("Masumi " + field[0] + " must be a positive POSIX-ms integer string");
      }
    }
    if (!MasumiConstants.deadlineIntervalsHold(
        new BigInteger(input.payByTime()),
        new BigInteger(input.submitResultTime()),
        new BigInteger(input.unlockTime()),
        new BigInteger(input.externalDisputeUnlockTime()))) {
      throw new IllegalArgumentException("Masumi deadline intervals are below the minimum");
    }
    assertWindow(
        input.payByTime(), input.submitResultTime(), input.externalDisputeUnlockTime(),
        input.maxTimeoutSeconds(), nowMs, horizon(input));
  }

  private static BigInteger horizon(Input input) {
    return input.maxDeadlineHorizonMs() == null ? MasumiConstants.MAX_DEADLINE_HORIZON_MS : input.maxDeadlineHorizonMs();
  }

  private static void assertWindow(
      String payByTimeText,
      String submitResultTime,
      String externalDisputeUnlockTime,
      int maxTimeoutSeconds,
      BigInteger nowMs,
      BigInteger maxDeadlineHorizonMs) {
    BigInteger payByTime = new BigInteger(payByTimeText);
    if (payByTime.compareTo(nowMs) <= 0) {
      throw new IllegalArgumentException("Masumi payByTime must be in the future");
    }
    if (new BigInteger(submitResultTime).compareTo(nowMs.add(MasumiConstants.MIN_SUBMIT_RESULT_LEAD_MS)) < 0) {
      throw new IllegalArgumentException("Masumi submitResultTime must be at least 15 minutes away");
    }
    if (new BigInteger(externalDisputeUnlockTime).compareTo(nowMs.add(maxDeadlineHorizonMs)) > 0) {
      throw new IllegalArgumentException("Masumi deadlines extend beyond the accepted horizon");
    }
    if (payByTime.compareTo(nowMs.add(BigInteger.valueOf(maxTimeoutSeconds).multiply(BigInteger.valueOf(1000)))) > 0) {
      throw new IllegalArgumentException("Masumi payByTime exceeds maxTimeoutSeconds");
    }
  }

  private static String randomHex(int bytes) {
    byte[] buffer = new byte[bytes];
    RANDOM.nextBytes(buffer);
    return HexFormat.of().formatHex(buffer);
  }

  /**
   * Issues a Masumi {@code PaymentRequirements}; {@code payTo} is derived from the deployment.
   *
   * @param input what to issue
   * @return the complete requirements
   * @throws IllegalArgumentException when the 402 would be unpayable or invalid
   */
  public static PaymentRequirements issue(Input input) {
    if (input.amount() == null || !CardanoConstants.POSITIVE_CANONICAL_AMOUNT.matcher(input.amount()).matches()) {
      throw new IllegalArgumentException("Masumi amount must be a positive canonical integer: " + input.amount());
    }
    if (input.asset() == null || !CardanoConstants.CANONICAL_ASSET.matcher(input.asset()).matches()) {
      throw new IllegalArgumentException("Masumi asset must use canonical lowercase form: " + input.asset());
    }
    if (input.maxTimeoutSeconds() <= 0) {
      throw new IllegalArgumentException("Masumi maxTimeoutSeconds must be a positive safe integer");
    }
    if (!input.unsafeSkipPolicyChecks()) {
      assertPolicy(input, BigInteger.valueOf(input.clock().millis()));
    }
    MasumiDeployment deployment = MasumiBlueprint.resolveDeployment(input.network(), input.deployment());
    if (deployment == null) {
      throw new IllegalArgumentException(
          "Network " + input.network() + " has no canonical Masumi deployment; supply extra.deployment");
    }
    String payTo = MasumiBlueprint.escrowAddress(input.network(), deployment);

    List<MasumiCommitmentPart> parts = new ArrayList<>();
    for (MasumiCommitmentInput part : input.commitment()) {
      parts.add(
          new MasumiCommitmentPart(
              part.name(),
              part.canonicalization(),
              part.mediaType(),
              part.echoContent(),
              part.echoContent() ? part.content() : null,
              MasumiDigests.commitmentPartDigest(part.canonicalization(), part.content())));
    }
    MasumiInputCommitment draft = new MasumiInputCommitment("1", "sha256", parts, "");
    MasumiInputCommitment commitment =
        new MasumiInputCommitment("1", "sha256", parts, MasumiDigests.computeInputHash(draft));

    MasumiTerms terms =
        new MasumiTerms(
            "1",
            MasumiConstants.PAYMENT_SOURCE_TYPE,
            input.sellerAddress(),
            input.sellerReturnAddress(),
            input.sellerNonce() != null ? input.sellerNonce() : randomHex(32),
            input.buyerNonce() != null ? input.buyerNonce() : "",
            input.agentIdentifierPresent(),
            input.agentIdentifier(),
            commitment.digest(),
            input.payByTime(),
            input.submitResultTime(),
            input.unlockTime(),
            input.externalDisputeUnlockTime());

    PaymentRequirements unsigned =
        new PaymentRequirements(
            CardanoConstants.SCHEME_EXACT, input.network(), input.asset(), input.amount(), payTo,
            input.maxTimeoutSeconds(), null);
    String termsDigest =
        MasumiDigests.computeTermsDigest(
            MasumiDigests.buildSignedTerms(terms.toJson(), MasumiExtra.ASSET_TRANSFER_METHOD, unsigned));
    MasumiSellerAuthorization authorization =
        Objects.requireNonNull(input.signTerms(), "signTerms").signTerms(input.sellerAddress(), termsDigest);
    String referenceKey = authorization.key().toLowerCase(Locale.ROOT);
    String referenceSignature = authorization.signature().toLowerCase(Locale.ROOT);

    if (!input.unsafeSkipPolicyChecks()) {
      assertWindow(
          terms.payByTime(), terms.submitResultTime(), terms.externalDisputeUnlockTime(),
          unsigned.maxTimeoutSeconds(), BigInteger.valueOf(input.clock().millis()), horizon(input));
    }

    MasumiExtra extra =
        new MasumiExtra(
            input.confirmationPolicy(),
            null,
            commitment,
            terms,
            referenceKey,
            referenceSignature,
            MasumiIdentifier.encode(
                new MasumiIdentifier.Parts(
                    terms.sellerNonce(),
                    terms.agentIdentifierOrEmpty(),
                    terms.buyerNonce(),
                    referenceSignature,
                    referenceKey,
                    payTo)),
            input.deployment());
    MasumiSchema.Result schema = MasumiSchema.validate(extra.toJson(), input.network());
    if (!schema.ok()) {
      throw new IllegalArgumentException("Issued Masumi requirements are invalid: " + schema.detail());
    }
    return unsigned.withExtra(extra.toJson());
  }
}
