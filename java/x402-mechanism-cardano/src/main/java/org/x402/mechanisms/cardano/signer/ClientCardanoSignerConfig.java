package org.x402.mechanisms.cardano.signer;

import com.bloxbean.cardano.client.api.ProtocolParamsSupplier;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import java.math.BigInteger;
import java.time.Clock;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.exact.client.MasumiBuyerInput;
import org.x402.mechanisms.cardano.exact.masumi.MasumiConstants;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeploymentValidator;
import org.x402.mechanisms.cardano.exact.masumi.MasumiExtra;
import org.x402.mechanisms.cardano.exact.masumi.MasumiRegistryValidator;

/**
 * Configuration of the mnemonic-backed client signer. One
 * signer serves one network with its own provider.
 *
 * @param mnemonic BIP-39 phrase of the funding wallet
 * @param network the x402 Cardano network
 * @param utxoSupplier the wallet's UTxOs on this network (e.g. a {@code BlockfrostChainBackend});
 *     it must throw when a read fails rather than answer a short list
 * @param protocolParamsSupplier live protocol parameters of this network
 * @param accountIndex derivation account index
 * @param masumiBuyerInput buyer-side datum input per payment, or {@code null}
 * @param validateMasumiRegistryClaim validates registry claims; without one they are refused
 * @param masumiRequestContent the buyer's content for commitment parts the issuer did not echo
 * @param validateCustomMasumiDeployment approves non-canonical deployments, or {@code null}
 * @param masumiMaxCollateralLovelace collateral ceiling (default 15 ADA)
 * @param masumiMaxDeadlineHorizonMs how far past now the last deadline may sit (default 30 days)
 * @param clock the clock for TTLs and deadline checks
 */
public record ClientCardanoSignerConfig(
    String mnemonic,
    String network,
    UtxoSupplier utxoSupplier,
    ProtocolParamsSupplier protocolParamsSupplier,
    int accountIndex,
    Function<MasumiExtra, MasumiBuyerInput> masumiBuyerInput,
    MasumiRegistryValidator validateMasumiRegistryClaim,
    Map<String, Object> masumiRequestContent,
    MasumiDeploymentValidator validateCustomMasumiDeployment,
    BigInteger masumiMaxCollateralLovelace,
    BigInteger masumiMaxDeadlineHorizonMs,
    Clock clock) {

  /** Validates and fills defaults. */
  public ClientCardanoSignerConfig {
    Objects.requireNonNull(mnemonic, "mnemonic");
    Objects.requireNonNull(utxoSupplier, "utxoSupplier");
    Objects.requireNonNull(protocolParamsSupplier, "protocolParamsSupplier");
    if (!CardanoNetworks.isCardanoNetwork(network)) {
      throw new IllegalArgumentException("Unsupported Cardano network: " + network);
    }
    for (Object provider : new Object[] {utxoSupplier, protocolParamsSupplier}) {
      if (provider instanceof BlockfrostChainBackend backend
          && !CardanoNetworks.normalize(backend.network()).equals(CardanoNetworks.normalize(network))) {
        throw new IllegalArgumentException(
            "Wallet provider serves " + backend.network() + ", not " + network);
      }
    }
    masumiRequestContent = masumiRequestContent == null ? null : java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(masumiRequestContent));
    masumiMaxCollateralLovelace =
        masumiMaxCollateralLovelace == null ? MasumiConstants.DEFAULT_MAX_COLLATERAL_LOVELACE : masumiMaxCollateralLovelace;
    masumiMaxDeadlineHorizonMs =
        masumiMaxDeadlineHorizonMs == null ? MasumiConstants.MAX_DEADLINE_HORIZON_MS : masumiMaxDeadlineHorizonMs;
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

  /** Builder for {@link ClientCardanoSignerConfig}. */
  public static final class Builder {
    private String mnemonic;
    private String network;
    private UtxoSupplier utxoSupplier;
    private ProtocolParamsSupplier protocolParamsSupplier;
    private int accountIndex;
    private Function<MasumiExtra, MasumiBuyerInput> masumiBuyerInput;
    private MasumiRegistryValidator validateMasumiRegistryClaim;
    private Map<String, Object> masumiRequestContent;
    private MasumiDeploymentValidator validateCustomMasumiDeployment;
    private BigInteger masumiMaxCollateralLovelace;
    private BigInteger masumiMaxDeadlineHorizonMs;
    private Clock clock;

    private Builder() {}

    /**
     * Sets the mnemonic.
     *
     * @param v the phrase
     * @return this builder
     */
    public Builder mnemonic(String v) {
      mnemonic = v;
      return this;
    }

    /**
     * Sets the network.
     *
     * @param v the network
     * @return this builder
     */
    public Builder network(String v) {
      network = v;
      return this;
    }

    /**
     * Sets one provider for both the wallet's UTxOs and the protocol parameters.
     *
     * @param v the provider, e.g. a {@code BlockfrostChainBackend}
     * @param <T> a type serving both
     * @return this builder
     */
    public <T extends UtxoSupplier & ProtocolParamsSupplier> Builder walletProvider(T v) {
      utxoSupplier = v;
      protocolParamsSupplier = v;
      return this;
    }

    /**
     * Sets the wallet's UTxO source.
     *
     * @param v the supplier
     * @return this builder
     */
    public Builder utxoSupplier(UtxoSupplier v) {
      utxoSupplier = v;
      return this;
    }

    /**
     * Sets the protocol-parameter source.
     *
     * @param v the supplier
     * @return this builder
     */
    public Builder protocolParamsSupplier(ProtocolParamsSupplier v) {
      protocolParamsSupplier = v;
      return this;
    }

    /**
     * Sets the account index.
     *
     * @param v the index
     * @return this builder
     */
    public Builder accountIndex(int v) {
      accountIndex = v;
      return this;
    }

    /**
     * Sets the buyer input hook.
     *
     * @param v the hook
     * @return this builder
     */
    public Builder masumiBuyerInput(Function<MasumiExtra, MasumiBuyerInput> v) {
      masumiBuyerInput = v;
      return this;
    }

    /**
     * Sets the registry validator.
     *
     * @param v the validator
     * @return this builder
     */
    public Builder validateMasumiRegistryClaim(MasumiRegistryValidator v) {
      validateMasumiRegistryClaim = v;
      return this;
    }

    /**
     * Sets the buyer's commitment content.
     *
     * @param v part name → content
     * @return this builder
     */
    public Builder masumiRequestContent(Map<String, Object> v) {
      masumiRequestContent = v;
      return this;
    }

    /**
     * Sets the deployment validator.
     *
     * @param v the validator
     * @return this builder
     */
    public Builder validateCustomMasumiDeployment(MasumiDeploymentValidator v) {
      validateCustomMasumiDeployment = v;
      return this;
    }

    /**
     * Sets the collateral ceiling.
     *
     * @param v lovelace
     * @return this builder
     */
    public Builder masumiMaxCollateralLovelace(BigInteger v) {
      masumiMaxCollateralLovelace = v;
      return this;
    }

    /**
     * Sets the deadline horizon.
     *
     * @param v milliseconds
     * @return this builder
     */
    public Builder masumiMaxDeadlineHorizonMs(BigInteger v) {
      masumiMaxDeadlineHorizonMs = v;
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
    public ClientCardanoSignerConfig build() {
      return new ClientCardanoSignerConfig(
          mnemonic, network, utxoSupplier, protocolParamsSupplier, accountIndex, masumiBuyerInput, validateMasumiRegistryClaim,
          masumiRequestContent, validateCustomMasumiDeployment, masumiMaxCollateralLovelace, masumiMaxDeadlineHorizonMs,
          clock);
    }
  }
}
