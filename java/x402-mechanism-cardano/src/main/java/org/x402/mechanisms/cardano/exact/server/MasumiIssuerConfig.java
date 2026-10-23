package org.x402.mechanisms.cardano.exact.server;

import java.math.BigInteger;
import java.time.Clock;
import java.util.List;
import java.util.Objects;
import java.util.function.Function;
import org.x402.core.types.PaymentPayload;
import org.x402.mechanisms.cardano.exact.masumi.MasumiCommitmentInput;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;

/**
 * Lets the server scheme issue Masumi quotes itself. A route then
 * declares only {@code extra: {assetTransferMethod: "masumi"}} with the escrow address as {@code
 * payTo}; every 402 gets a fresh seller-signed quote.
 *
 * @param seller the selling wallet per network (a fixed value or a resolver)
 * @param sellerReturnAddress optional key-credential payout address, or {@code null}
 * @param agentIdentifierPresent whether to sign an {@code agentIdentifier}
 * @param agentIdentifier the registry asset id ({@code null} is a distinct signed value)
 * @param deployment non-canonical parameters when a template declares none (required on Preview)
 * @param commitment builds the request commitment; default: one {@code jcs} part with the
 *     resource URL
 * @param deadlines escrow deadlines relative to {@code payByTime}
 * @param maxDeadlineHorizonMs the seller's horizon, or {@code null} for 30 days
 * @param paymentPayloadFromTransport reads the paid payload out of an unknown transport
 *     context, or {@code null}
 * @param clock the clock for {@code payByTime}
 */
public record MasumiIssuerConfig(
    Function<String, CardanoSellerSigner> seller,
    String sellerReturnAddress,
    boolean agentIdentifierPresent,
    String agentIdentifier,
    MasumiDeployment deployment,
    Function<MasumiIssueContext, List<MasumiCommitmentInput>> commitment,
    MasumiDeadlineOffsets deadlines,
    BigInteger maxDeadlineHorizonMs,
    Function<Object, PaymentPayload> paymentPayloadFromTransport,
    Clock clock) {

  /** Validates and fills defaults. */
  public MasumiIssuerConfig {
    Objects.requireNonNull(seller, "seller");
    deadlines = deadlines == null ? MasumiDeadlineOffsets.DEFAULT : deadlines;
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

  /** Builder for {@link MasumiIssuerConfig}. */
  public static final class Builder {
    private Function<String, CardanoSellerSigner> seller;
    private String sellerReturnAddress;
    private boolean agentIdentifierPresent;
    private String agentIdentifier;
    private MasumiDeployment deployment;
    private Function<MasumiIssueContext, List<MasumiCommitmentInput>> commitment;
    private MasumiDeadlineOffsets deadlines;
    private BigInteger maxDeadlineHorizonMs;
    private Function<Object, PaymentPayload> paymentPayloadFromTransport;
    private Clock clock;

    private Builder() {}

    /**
     * One seller for every network.
     *
     * @param signer the seller
     * @return this builder
     */
    public Builder seller(CardanoSellerSigner signer) {
      Objects.requireNonNull(signer, "signer");
      this.seller = network -> signer;
      return this;
    }

    /**
     * A seller per network.
     *
     * @param resolver network → seller
     * @return this builder
     */
    public Builder sellerResolver(Function<String, CardanoSellerSigner> resolver) {
      this.seller = resolver;
      return this;
    }

    /**
     * Sets the seller return address.
     *
     * @param v the address
     * @return this builder
     */
    public Builder sellerReturnAddress(String v) {
      sellerReturnAddress = v;
      return this;
    }

    /**
     * Signs an {@code agentIdentifier} ({@code null} signs JSON null).
     *
     * @param v the identifier
     * @return this builder
     */
    public Builder agentIdentifier(String v) {
      agentIdentifierPresent = true;
      agentIdentifier = v;
      return this;
    }

    /**
     * Sets the default deployment.
     *
     * @param v the deployment
     * @return this builder
     */
    public Builder deployment(MasumiDeployment v) {
      deployment = v;
      return this;
    }

    /**
     * Sets the commitment builder.
     *
     * @param v the builder function
     * @return this builder
     */
    public Builder commitment(Function<MasumiIssueContext, List<MasumiCommitmentInput>> v) {
      commitment = v;
      return this;
    }

    /**
     * Sets the deadline offsets.
     *
     * @param v the offsets
     * @return this builder
     */
    public Builder deadlines(MasumiDeadlineOffsets v) {
      deadlines = v;
      return this;
    }

    /**
     * Sets the seller's horizon.
     *
     * @param v milliseconds
     * @return this builder
     */
    public Builder maxDeadlineHorizonMs(BigInteger v) {
      maxDeadlineHorizonMs = v;
      return this;
    }

    /**
     * Sets the transport payload reader.
     *
     * @param v the reader
     * @return this builder
     */
    public Builder paymentPayloadFromTransport(Function<Object, PaymentPayload> v) {
      paymentPayloadFromTransport = v;
      return this;
    }

    /**
     * Sets the clock.
     *
     * @param v the clock
     * @return this builder
     */
    public Builder clock(Clock v) {
      clock = v;
      return this;
    }

    /**
     * Builds the config.
     *
     * @return the config
     */
    public MasumiIssuerConfig build() {
      return new MasumiIssuerConfig(
          seller, sellerReturnAddress, agentIdentifierPresent, agentIdentifier, deployment, commitment, deadlines,
          maxDeadlineHorizonMs, paymentPayloadFromTransport, clock);
    }
  }
}
