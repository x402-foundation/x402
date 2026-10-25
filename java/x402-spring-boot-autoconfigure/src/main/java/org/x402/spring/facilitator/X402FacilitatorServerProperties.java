package org.x402.spring.facilitator;

import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.x402.spring.cardano.X402CardanoProperties;

/**
 * x402.facilitator-server.*. Independent of x402.enabled.
 *
 * @param enabled run the facilitator (default false)
 * @param exposeHttp serve /verify, /settle, /supported (default true); false keeps it in-process
 *     (local client, own controllers)
 * @param basePath the endpoint prefix (default /x402); "" or / = root
 * @param cardano the Cardano facilitator
 */
@ConfigurationProperties("x402.facilitator-server")
public record X402FacilitatorServerProperties(
    boolean enabled,
    @DefaultValue("true") boolean exposeHttp,
    @DefaultValue("/x402") String basePath,
    @DefaultValue Cardano cardano) {

  /**
   * The Cardano facilitator.
   *
   * @param acceptMempool accept l1Confirmations: -1 (mempool) payments
   * @param confirmationTimeout how long settle waits for confirmations (default 75 s). The wait
   *     also ends when the settle's budget does ({@code settleTimeout} less
   *     {@code chainCallReserve}, 60 s by default), so with the defaults that budget decides; a
   *     configured value above the budget has no effect (logged as a warning)
   * @param confirmationPoll interval between confirmation checks (default 5 s)
   * @param settleTimeout how long one settle may take in total, verification and broadcast
   *     included (default 75 s; keep below 85 s). No broadcast or evidence read starts in its last
   *     {@code chainCallReserve}, kept for the chain call in flight; past that point the answer is
   *     {@code settlement_pending}
   * @param chainCallReserve the end part of {@code settleTimeout} in which no broadcast or evidence
   *     read starts (default 15 s, half the settle timeout when that is under 30 s; must be shorter
   *     than the settle timeout). One Blockfrost evidence read is up to four requests of up to 10 s
   *     each: 40 s makes the settle timeout a hard bound, at the cost of a shorter confirmation wait
   * @param networks one scheme, backend and optional signer per network
   * @param maxTipAge how far a provider's tip may lag before reads are refused (default 5m)
   * @param lookupTimeout bound on the chain lookups of one verification (default 10s)
   * @param maxInputLookups how many inputs one verification resolves on chain (default 64)
   * @param scriptDatumPolicy how strictly a script payment's datum is checked: {@code reference}
   *     (default), {@code strict} or {@code v3-optional}
   * @param maxTxBytes the largest transaction verify accepts (default 65536, at most 65536)
   */
  public record Cardano(
      boolean acceptMempool,
      @DefaultValue("75s") Duration confirmationTimeout,
      @DefaultValue("5s") Duration confirmationPoll,
      @DefaultValue("75s") Duration settleTimeout,
      Duration chainCallReserve,
      @DefaultValue("5m") Duration maxTipAge,
      @DefaultValue("10s") Duration lookupTimeout,
      @DefaultValue("64") int maxInputLookups,
      @DefaultValue("reference") String scriptDatumPolicy,
      @DefaultValue("65536") int maxTxBytes,
      List<Network> networks) {

    /** Normalizes an absent list and settle timeout. */
    @ConstructorBinding
    public Cardano {
      settleTimeout = settleTimeout == null ? Duration.ofSeconds(75) : settleTimeout;
      networks = networks == null ? List.of() : List.copyOf(networks);
    }

    /**
     * The Cardano facilitator with the default settle timeout (the constructor before {@code
     * settleTimeout} existed).
     *
     * @param acceptMempool accept l1Confirmations: -1 (mempool) payments
     * @param confirmationTimeout how long settle waits for confirmations
     * @param confirmationPoll interval between confirmation checks
     * @param maxTipAge how far a provider's tip may lag before reads are refused
     * @param lookupTimeout bound on the chain lookups of one verification
     * @param maxInputLookups how many inputs one verification resolves on chain
     * @param scriptDatumPolicy how strictly a script payment's datum is checked
     * @param maxTxBytes the largest transaction verify accepts
     * @param networks one scheme, backend and optional signer per network
     */
    public Cardano(boolean acceptMempool, Duration confirmationTimeout, Duration confirmationPoll,
        Duration maxTipAge, Duration lookupTimeout, int maxInputLookups, String scriptDatumPolicy,
        int maxTxBytes, List<Network> networks) {
      this(acceptMempool, confirmationTimeout, confirmationPoll, null, null, maxTipAge, lookupTimeout,
          maxInputLookups, scriptDatumPolicy, maxTxBytes, networks);
    }
  }

  /**
   * One Cardano network.
   *
   * @param network the CAIP-2 network
   * @param blockfrost the Blockfrost backend
   * @param mnemonic optional facilitator mnemonic (only shown as an address in /supported);
   *     provider-only without it
   * @param slotConfig the network's slot configuration (e.g. a private testnet), or {@code null}
   *     for the built-in one
   * @param networkMagic the genesis network magic the provider must report; defaults to the
   *     public network's (764824073, 1, 2), required to check a private network
   * @param evaluation whether the provider offers transaction evaluation; {@code false} (e.g.
   *     yaci-store) skips verify's dry-run (default {@code true})
   * @param masumiAllowedScriptHashes Masumi escrow script hashes accepted on this network; when set,
   *     every other escrow (the canonical one included) is refused
   */
  public record Network(String network, X402CardanoProperties.Blockfrost blockfrost,
      String mnemonic, SlotConfig slotConfig, Integer networkMagic, Boolean evaluation,
      List<String> masumiAllowedScriptHashes) {}

  /**
   * A Shelley-era slot configuration; all three values are required together.
   *
   * @param zeroTime POSIX milliseconds of {@code zeroSlot}
   * @param zeroSlot the first slot of the configuration
   * @param slotLength milliseconds per slot
   */
  public record SlotConfig(Long zeroTime, Long zeroSlot, Integer slotLength) {}
}
