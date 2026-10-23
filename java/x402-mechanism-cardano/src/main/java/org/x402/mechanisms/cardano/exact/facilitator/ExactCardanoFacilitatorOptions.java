package org.x402.mechanisms.cardano.exact.facilitator;

import com.bloxbean.cardano.client.common.model.SlotConfig;
import java.time.Clock;
import java.time.Duration;
import java.util.Set;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeploymentValidator;
import org.x402.mechanisms.cardano.exact.masumi.MasumiRegistryValidator;

/**
 * Options of the Cardano facilitator scheme.
 *
 * @param settlementStore the duplicate-settlement guard (default: a bounded {@link
 *     InMemorySettlementClaimStore}, right for a single instance)
 * @param acceptMempool settle on authenticated mempool evidence when the policy allows {@code
 *     -1} (default {@code false})
 * @param confirmationTimeout how long one settle waits for the policy's evidence before
 *     answering {@code settlement_pending} (default 75 s). The wait also ends when the settle's
 *     budget for chain calls does ({@code settleTimeout - chainCallReserve} after the settle
 *     started, 60 s with the defaults), so with the default settle timeout the budget decides. A
 *     configured value above {@code settleTimeout - chainCallReserve} has no effect; the scheme
 *     logs a warning for it (not for the default, which stands for "as long as the settle
 *     allows")
 * @param confirmationPoll interval between evidence polls (default 5 s)
 * @param registryValidator validates Masumi registry claims; without one a non-empty {@code
 *     agentIdentifier} is rejected
 * @param deploymentValidator approves non-canonical Masumi deployments
 * @param clock the clock of the confirmation wait (default {@code Clock.systemUTC()})
 * @param slotConfig the slot configuration of the network this scheme serves, or {@code null} for
 *     the network's built-in one (e.g. a private testnet)
 * @param lookupTimeout how long one verification may spend resolving inputs on chain (default
 *     10 s); past it the verdict is {@code chain_lookup_failed}
 * @param maxInputLookups how many inputs one verification may resolve on chain (default 64; 0
 *     means the default); a transaction with more is {@code chain_lookup_failed} before any lookup
 * @param masumiAllowedScriptHashes Masumi escrow script hashes accepted on this network; when
 *     non-empty every other escrow (the canonical one included) is refused and an allowlisted custom
 *     deployment needs no {@code deploymentValidator} (default empty: the default rules)
 * @param scriptDatumPolicy how strictly a script payment's datum is checked (default {@link
 *     ScriptDatumPolicy#REFERENCE})
 * @param maxTransactionBytes the largest transaction verify accepts (default and upper bound 64 KiB;
 *     0 means the default); the protocol's {@code maxTxSize} lowers it further
 * @param settleTimeout how long one settle may take in total, verification and broadcast
 *     included (default 75 s, below the resource servers' facilitator timeout of 90 s). Settle
 *     starts neither the broadcast nor an evidence read in its last {@code chainCallReserve}; past
 *     that point the answer is {@code settlement_pending}. The settle therefore answers within this
 *     timeout as long as the chain call in flight ends within the reserve. Verification's own
 *     lookups are bounded by {@code lookupTimeout} and the backend, not by this timeout
 * @param chainCallReserve the end part of {@code settleTimeout} kept for the chain call in
 *     flight (the submission, one evidence read, or the tip read that decides expiry): no such
 *     call starts in it (default 15 s, at most half the settle timeout; must be shorter than the
 *     settle timeout). One call is one backend method, which may make several provider requests:
 *     a {@link org.x402.mechanisms.cardano.chain.BlockfrostChainBackend} evidence read is up to
 *     four (the provider check's genesis and tip reads, the transaction, then the mempool or the
 *     tip), each bounded by its request timeout, so a hard bound with Blockfrost's 10 s request
 *     timeout needs 40 s. A larger reserve leaves less of the settle for the confirmation wait
 */
public record ExactCardanoFacilitatorOptions(
    SettlementClaimStore settlementStore,
    boolean acceptMempool,
    Duration confirmationTimeout,
    Duration confirmationPoll,
    MasumiRegistryValidator registryValidator,
    MasumiDeploymentValidator deploymentValidator,
    Clock clock,
    SlotConfig slotConfig,
    Duration lookupTimeout,
    int maxInputLookups,
    Set<String> masumiAllowedScriptHashes,
    ScriptDatumPolicy scriptDatumPolicy,
    int maxTransactionBytes,
    Duration settleTimeout,
    Duration chainCallReserve) {

  /** Default confirmation wait. */
  public static final Duration DEFAULT_CONFIRMATION_TIMEOUT = Duration.ofSeconds(75);
  /** Default bound on the chain lookups of one verification. */
  public static final Duration DEFAULT_LOOKUP_TIMEOUT = Duration.ofSeconds(10);
  /** Default bound on the inputs one verification resolves. */
  public static final int DEFAULT_MAX_INPUT_LOOKUPS = 64;
  /** Default poll interval. */
  public static final Duration DEFAULT_CONFIRMATION_POLL = Duration.ofSeconds(5);
  /** Default bound on one whole settle. */
  public static final Duration DEFAULT_SETTLE_TIMEOUT = Duration.ofSeconds(75);
  /**
   * Default reserve for the chain call in flight when a settle's budget runs out: with the
   * default settle timeout, a call that starts at the last moment may take 15 s and still answer
   * by 75 s, or 30 s and still answer before the resource servers' 90 s timeout.
   */
  public static final Duration DEFAULT_CHAIN_CALL_RESERVE = Duration.ofSeconds(15);

  /** Fills defaults for {@code null} members. */
  public ExactCardanoFacilitatorOptions {
    clock = clock == null ? Clock.systemUTC() : clock;
    settlementStore =
        settlementStore == null
            ? new InMemorySettlementClaimStore(InMemorySettlementClaimStore.DEFAULT_MAX_ENTRIES, clock)
            : settlementStore;
    confirmationTimeout = confirmationTimeout == null ? DEFAULT_CONFIRMATION_TIMEOUT : confirmationTimeout;
    confirmationPoll = confirmationPoll == null ? DEFAULT_CONFIRMATION_POLL : confirmationPoll;
    lookupTimeout = lookupTimeout == null ? DEFAULT_LOOKUP_TIMEOUT : lookupTimeout;
    settleTimeout = settleTimeout == null ? DEFAULT_SETTLE_TIMEOUT : settleTimeout;
    if (settleTimeout.isNegative() || settleTimeout.isZero()) {
      throw new IllegalArgumentException("settle timeout must be positive");
    }
    if (chainCallReserve == null) {
      // A short settle timeout keeps half of itself for verification and the broadcast.
      Duration half = settleTimeout.dividedBy(2);
      chainCallReserve = DEFAULT_CHAIN_CALL_RESERVE.compareTo(half) <= 0 ? DEFAULT_CHAIN_CALL_RESERVE : half;
    }
    if (chainCallReserve.isNegative() || chainCallReserve.compareTo(settleTimeout) >= 0) {
      // A reserve as long as the settle timeout would never let a settle broadcast.
      throw new IllegalArgumentException("chain call reserve must be from 0 to less than the settle timeout");
    }
    maxInputLookups = maxInputLookups == 0 ? DEFAULT_MAX_INPUT_LOOKUPS : maxInputLookups;
    scriptDatumPolicy = scriptDatumPolicy == null ? ScriptDatumPolicy.REFERENCE : scriptDatumPolicy;
    maxTransactionBytes = maxTransactionBytes == 0 ? CardanoConstants.MAX_TRANSACTION_BYTES : maxTransactionBytes;
    if (maxTransactionBytes < 0 || maxTransactionBytes > CardanoConstants.MAX_TRANSACTION_BYTES) {
      throw new IllegalArgumentException("max transaction bytes must be from 1 to "
          + CardanoConstants.MAX_TRANSACTION_BYTES);
    }
    masumiAllowedScriptHashes =
        masumiAllowedScriptHashes == null ? Set.of() : Set.copyOf(masumiAllowedScriptHashes);
    if (slotConfig != null && slotConfig.getSlotLength() <= 0) {
      throw new IllegalArgumentException("slot length must be positive");
    }
    if (maxInputLookups < 0) {
      throw new IllegalArgumentException("max input lookups must not be negative");
    }
    if (lookupTimeout.isNegative() || lookupTimeout.isZero()) {
      throw new IllegalArgumentException("lookup timeout must be positive");
    }
    if (confirmationTimeout.isNegative() || confirmationPoll.isNegative()) {
      throw new IllegalArgumentException("confirmation timeout and poll must not be negative");
    }
    try {
      // Settle converts both after broadcast, where an overflow must not surface.
      confirmationTimeout.toMillis();
      confirmationPoll.toMillis();
      lookupTimeout.toNanos();
      settleTimeout.toMillis();
      chainCallReserve.toMillis();
    } catch (ArithmeticException e) {
      throw new IllegalArgumentException("confirmation timeout and poll must fit in milliseconds", e);
    }
  }

  /**
   * The options with the default settle timeout and chain-call reserve.
   *
   * @param settlementStore the claim store, or {@code null} for the in-memory default
   * @param acceptMempool whether mempool evidence may settle a {@code -1} policy
   * @param confirmationTimeout how long one settle waits, or {@code null} for the default
   * @param confirmationPoll the evidence poll interval, or {@code null} for the default
   * @param registryValidator the Masumi registry validator, or {@code null}
   * @param deploymentValidator the Masumi deployment validator, or {@code null}
   * @param clock the clock, or {@code null} for the system clock
   * @param slotConfig the slot configuration override, or {@code null}
   * @param lookupTimeout the input lookup budget, or {@code null} for the default
   * @param maxInputLookups the input lookup bound, 0 for the default
   * @param masumiAllowedScriptHashes the Masumi escrow allowlist, or {@code null}
   * @param scriptDatumPolicy the script datum policy, or {@code null} for the default
   * @param maxTransactionBytes the transaction size bound, 0 for the default
   */
  public ExactCardanoFacilitatorOptions(SettlementClaimStore settlementStore, boolean acceptMempool,
      Duration confirmationTimeout, Duration confirmationPoll,
      MasumiRegistryValidator registryValidator, MasumiDeploymentValidator deploymentValidator,
      Clock clock, SlotConfig slotConfig, Duration lookupTimeout, int maxInputLookups,
      Set<String> masumiAllowedScriptHashes, ScriptDatumPolicy scriptDatumPolicy,
      int maxTransactionBytes) {
    this(settlementStore, acceptMempool, confirmationTimeout, confirmationPoll, registryValidator,
        deploymentValidator, clock, slotConfig, lookupTimeout, maxInputLookups,
        masumiAllowedScriptHashes, scriptDatumPolicy, maxTransactionBytes, null, null);
  }

  /**
   * The options without a slot-configuration override.
   *
   * @param settlementStore the claim store, or {@code null} for the in-memory default
   * @param acceptMempool whether mempool evidence may settle a {@code -1} policy
   * @param confirmationTimeout how long one settle waits, or {@code null} for the default
   * @param confirmationPoll the evidence poll interval, or {@code null} for the default
   * @param registryValidator the Masumi registry validator, or {@code null}
   * @param deploymentValidator the Masumi deployment validator, or {@code null}
   * @param clock the clock, or {@code null} for the system clock
   */
  public ExactCardanoFacilitatorOptions(SettlementClaimStore settlementStore, boolean acceptMempool,
      Duration confirmationTimeout, Duration confirmationPoll,
      MasumiRegistryValidator registryValidator, MasumiDeploymentValidator deploymentValidator,
      Clock clock) {
    this(settlementStore, acceptMempool, confirmationTimeout, confirmationPoll, registryValidator,
        deploymentValidator, clock, null, null, 0, null, null, 0);
  }

  /**
   * The slot configuration of the network this scheme serves: the override, else the network's
   * built-in one.
   *
   * @param network the network
   * @return the slot configuration
   */
  public SlotConfig slotConfigFor(String network) {
    return slotConfig != null ? slotConfig : CardanoNetworks.slotConfig(network);
  }

  /**
   * The defaults, with a fresh in-memory settlement store.
   *
   * @return the options
   */
  public static ExactCardanoFacilitatorOptions defaults() {
    return builder().build();
  }

  /**
   * A builder starting from the defaults.
   *
   * @return the builder
   */
  public static Builder builder() {
    return new Builder();
  }

  /** Builder for {@link ExactCardanoFacilitatorOptions}. */
  public static final class Builder {
    private SettlementClaimStore settlementStore;
    private boolean acceptMempool;
    private Duration confirmationTimeout;
    private Duration confirmationPoll;
    private MasumiRegistryValidator registryValidator;
    private MasumiDeploymentValidator deploymentValidator;
    private Clock clock;
    private SlotConfig slotConfig;
    private Set<String> masumiAllowedScriptHashes;
    private ScriptDatumPolicy scriptDatumPolicy;
    private int maxTransactionBytes;
    private Duration lookupTimeout;
    private int maxInputLookups;
    private Duration settleTimeout;
    private Duration chainCallReserve;

    private Builder() {}

    /**
     * Sets the claim store.
     *
     * @param v the store
     * @return this builder
     */
    public Builder settlementStore(SettlementClaimStore v) {
      settlementStore = v;
      return this;
    }

    /**
     * Sets mempool acceptance.
     *
     * @param v the flag
     * @return this builder
     */
    public Builder acceptMempool(boolean v) {
      acceptMempool = v;
      return this;
    }

    /**
     * Sets the confirmation wait.
     *
     * @param v the duration
     * @return this builder
     */
    public Builder confirmationTimeout(Duration v) {
      confirmationTimeout = v;
      return this;
    }

    /**
     * Sets the poll interval.
     *
     * @param v the duration
     * @return this builder
     */
    public Builder confirmationPoll(Duration v) {
      confirmationPoll = v;
      return this;
    }

    /**
     * Sets the registry validator.
     *
     * @param v the validator
     * @return this builder
     */
    public Builder registryValidator(MasumiRegistryValidator v) {
      registryValidator = v;
      return this;
    }

    /**
     * Sets the deployment validator.
     *
     * @param v the validator
     * @return this builder
     */
    public Builder deploymentValidator(MasumiDeploymentValidator v) {
      deploymentValidator = v;
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
     * Sets the slot configuration of the network this scheme serves (e.g. a private testnet);
     * {@code null} keeps the network's built-in one.
     *
     * @param v the slot configuration
     * @return this builder
     */
    public Builder slotConfig(SlotConfig v) {
      slotConfig = v;
      return this;
    }

    /**
     * Bounds the chain lookups of one verification.
     *
     * @param v the bound, or {@code null} for the default (10 s)
     * @return this builder
     */
    public Builder lookupTimeout(Duration v) {
      lookupTimeout = v;
      return this;
    }

    /**
     * Bounds how many inputs one verification resolves on chain.
     *
     * @param v the bound, or 0 for the default (64)
     * @return this builder
     */
    public Builder maxInputLookups(int v) {
      maxInputLookups = v;
      return this;
    }

    /**
     * Pins the Masumi escrow scripts accepted on this network.
     *
     * @param v the script hashes (hex), or empty for the default rules
     * @return this builder
     */
    public Builder masumiAllowedScriptHashes(Set<String> v) {
      masumiAllowedScriptHashes = v;
      return this;
    }

    /**
     * Sets how strictly a script payment's datum is checked.
     *
     * @param v the policy, or {@code null} for {@link ScriptDatumPolicy#REFERENCE}
     * @return this builder
     */
    public Builder scriptDatumPolicy(ScriptDatumPolicy v) {
      scriptDatumPolicy = v;
      return this;
    }

    /**
     * Bounds the transaction size verify accepts.
     *
     * @param v the bound in bytes, or 0 for the default (64 KiB)
     * @return this builder
     */
    public Builder maxTransactionBytes(int v) {
      maxTransactionBytes = v;
      return this;
    }

    /**
     * Sets how long one settle may take in total (default 75 s).
     *
     * @param v the bound, or {@code null} for the default
     * @return this builder
     */
    public Builder settleTimeout(Duration v) {
      settleTimeout = v;
      return this;
    }

    /**
     * Sets the end part of the settle timeout in which no broadcast or evidence read starts
     * (default 15 s, at most half the settle timeout).
     *
     * @param v the reserve, or {@code null} for the default
     * @return this builder
     */
    public Builder chainCallReserve(Duration v) {
      chainCallReserve = v;
      return this;
    }

    /**
     * Builds the options.
     *
     * @return the options
     */
    public ExactCardanoFacilitatorOptions build() {
      return new ExactCardanoFacilitatorOptions(
          settlementStore, acceptMempool, confirmationTimeout, confirmationPoll, registryValidator,
          deploymentValidator, clock, slotConfig, lookupTimeout, maxInputLookups, masumiAllowedScriptHashes,
          scriptDatumPolicy, maxTransactionBytes, settleTimeout, chainCallReserve);
    }
  }
}
