package org.x402.mechanisms.cardano.signer;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.CardanoUtils;
import org.x402.mechanisms.cardano.utils.MnemonicAccounts;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.exact.client.ClientCardanoSignInput;
import org.x402.mechanisms.cardano.exact.client.ClientCardanoSignResult;
import org.x402.mechanisms.cardano.exact.client.ClientCardanoSigner;
import org.x402.mechanisms.cardano.exact.client.MasumiBuyerInput;
import org.x402.mechanisms.cardano.exact.client.MasumiLock;
import org.x402.mechanisms.cardano.exact.client.PaymentTransactionBuilder;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDatum;
import org.x402.mechanisms.cardano.exact.masumi.MasumiExtra;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.masumi.MasumiVerifier;
import org.x402.mechanisms.cardano.exact.script.ScriptDatum;

/**
 * The reference client signer: a BIP-39 wallet on one network.
 * It validates a Masumi 402 completely before touching the wallet, uses the first wallet UTxO as
 * the nonce, pays the requested asset to {@code payTo}, sets the TTL from {@code
 * maxTimeoutSeconds} (Masumi: {@code payByTime}), signs offline and never broadcasts.
 */
public final class MnemonicClientCardanoSigner implements ClientCardanoSigner {

  private static final EdDSASigningProvider ED25519 = new EdDSASigningProvider();

  private final ClientCardanoSignerConfig config;
  private final String address;
  private final byte[] privateKey;
  private final byte[] publicKey;
  private final Map<String, Object> requestContent;

  /**
   * Derives the wallet.
   *
   * @param config the configuration
   */
  public MnemonicClientCardanoSigner(ClientCardanoSignerConfig config) {
    this.config = Objects.requireNonNull(config, "config");
    Account account = MnemonicAccounts.account(config.mnemonic(), config.network(), config.accountIndex());
    this.address = account.baseAddress();
    this.privateKey = account.privateKeyBytes();
    this.publicKey = account.publicKeyBytes();
    this.requestContent =
        config.masumiRequestContent() == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(config.masumiRequestContent()));
  }

  @Override
  public String getAddress() {
    return address;
  }

  @Override
  public ClientCardanoSignResult buildAndSignPaymentTransaction(ClientCardanoSignInput input) {
    if (!Objects.equals(CardanoNetworks.normalize(input.network()), CardanoNetworks.normalize(config.network()))) {
      throw new IllegalArgumentException(
          "Signer configured for " + config.network() + " but asked to pay on " + input.network());
    }
    BigInteger amount = new BigInteger(input.amount());
    String asset = input.asset().toLowerCase(Locale.ROOT);
    boolean isLovelace = CardanoConstants.LOVELACE.equals(asset);
    Map<String, Object> extra = input.extra() == null ? Map.of() : input.extra();

    // Every Masumi guard runs before the wallet's UTxOs are read.
    MasumiExtra masumi = null;
    MasumiLock.Lock lock = null;
    ProtocolParams parameters = null;
    if (CardanoConstants.METHOD_MASUMI.equals(extra.get("assetTransferMethod"))) {
      masumi = guardMasumi(input, extra);
      MasumiBuyerInput buyerInput = config.masumiBuyerInput() == null ? null : config.masumiBuyerInput().apply(masumi);
      if (buyerInput == null) {
        buyerInput = MasumiBuyerInput.NONE;
      }
      if (buyerInput.buyerReturnAddress() != null
          && !CardanoAddresses.isKeyCredentialAddressOn(buyerInput.buyerReturnAddress(), input.network())) {
        throw new IllegalArgumentException("Masumi buyer return address must be a key-credential address on network");
      }
      parameters = CardanoUtils.requireComplete(config.protocolParamsSupplier().getProtocolParams());
      lock = MasumiLock.build(masumi, address, asset, amount, CardanoUtils.coinsPerUtxoByte(parameters), buyerInput);
      MasumiDatum.View view = MasumiDatum.parse(PlutusEncoding.encode(lock.datum()));
      if (view == null) {
        throw new IllegalStateException("Masumi client preflight could not decode the lock datum");
      }
      MasumiVerifier.Check invariants = MasumiVerifier.verifyDatumInvariants(view, input.payTo());
      if (!invariants.ok()) {
        throw new IllegalStateException(
            "Masumi client preflight failed: " + invariants.reason()
                + (invariants.detail() == null ? "" : " (" + invariants.detail() + ")"));
      }
      if (lock.collateralLovelace().compareTo(config.masumiMaxCollateralLovelace()) > 0) {
        throw new IllegalStateException(
            "Masumi client preflight failed: collateral " + lock.collateralLovelace()
                + " exceeds the configured maximum " + config.masumiMaxCollateralLovelace());
      }
    }

    List<Utxo> utxos = new ArrayList<>(config.utxoSupplier().getAll(address));
    utxos.removeIf(u -> u.getReferenceScriptHash() != null);
    if (utxos.isEmpty()) {
      throw new IllegalStateException("Funding wallet has no UTXOs available for the payment");
    }
    if (parameters == null) {
      parameters = CardanoUtils.requireComplete(config.protocolParamsSupplier().getProtocolParams());
    }

    Map<String, BigInteger> assets = isLovelace ? Map.of() : Map.of(asset, amount);
    PaymentTransactionBuilder.Payment payment;
    long ttlMs;
    if (masumi != null) {
      payment =
          new PaymentTransactionBuilder.Payment(
              new PaymentTransactionBuilder.Output(input.payTo(), lock.lockedLovelace(), assets, PlutusEncoding.encode(lock.datum())),
              false);
      ttlMs = Long.parseLong(masumi.terms().payByTime());
    } else {
      byte[] datum =
          CardanoConstants.METHOD_SCRIPT.equals(extra.get("assetTransferMethod")) ? ScriptDatum.datumBytes(extra) : null;
      payment =
          new PaymentTransactionBuilder.Payment(
              new PaymentTransactionBuilder.Output(input.payTo(), isLovelace ? amount : BigInteger.ZERO, assets, datum),
              !isLovelace || datum != null);
      ttlMs = config.clock().millis() + input.maxTimeoutSeconds() * 1000L;
    }
    BigInteger ttlSlot = BigInteger.valueOf(CardanoNetworks.posixMsToSlot(input.network(), ttlMs));

    PaymentTransactionBuilder.Built built =
        PaymentTransactionBuilder.build(
            new PaymentTransactionBuilder.Spec(utxos, address, payment, ttlSlot, parameters),
            hash -> new byte[][] {publicKey, ED25519.signExtended(hash, privateKey, publicKey)});

    if (masumi != null && new BigInteger(masumi.terms().payByTime()).compareTo(BigInteger.valueOf(config.clock().millis())) <= 0) {
      throw new IllegalStateException("Masumi client preflight failed: payByTime has expired");
    }
    return new ClientCardanoSignResult(Base64.getEncoder().encodeToString(built.bytes()), built.nonce());
  }

  private MasumiExtra guardMasumi(ClientCardanoSignInput input, Map<String, Object> extra) {
    MasumiSchema.Result schema = MasumiSchema.validate(extra, input.network());
    if (!schema.ok()) {
      throw new IllegalArgumentException("Masumi payment requirements are invalid: " + schema.detail());
    }
    MasumiExtra masumi = schema.extra();
    PaymentRequirements requirements =
        new PaymentRequirements(
            CardanoConstants.SCHEME_EXACT, input.network(), input.asset(), input.amount(), input.payTo(),
            input.maxTimeoutSeconds(), extra);
    MasumiVerifier.Authorization authorization =
        MasumiVerifier.verifyAuthorization(
            masumi,
            requirements,
            new MasumiVerifier.AuthorizationOptions(
                config.validateMasumiRegistryClaim(),
                input.resource(),
                config.validateCustomMasumiDeployment(),
                requestContent,
                true,
                config.masumiMaxDeadlineHorizonMs(),
                config.clock()));
    if (!authorization.ok()) {
      throw new IllegalArgumentException(
          "Masumi seller authorization failed: " + authorization.reason()
              + (authorization.detail() == null ? "" : " (" + authorization.detail() + ")"));
    }
    if (input.maxTimeoutSeconds() <= 0) {
      throw new IllegalArgumentException("Masumi maxTimeoutSeconds must be a positive safe integer");
    }
    BigInteger payByTime = new BigInteger(masumi.terms().payByTime());
    BigInteger now = BigInteger.valueOf(config.clock().millis());
    if (payByTime.compareTo(now) <= 0) {
      throw new IllegalArgumentException("Masumi client preflight failed: payByTime has expired");
    }
    if (payByTime.compareTo(now.add(BigInteger.valueOf(input.maxTimeoutSeconds()).multiply(BigInteger.valueOf(1000)))) > 0) {
      throw new IllegalArgumentException("Masumi client preflight failed: payByTime exceeds maxTimeoutSeconds");
    }
    return masumi;
  }
}
