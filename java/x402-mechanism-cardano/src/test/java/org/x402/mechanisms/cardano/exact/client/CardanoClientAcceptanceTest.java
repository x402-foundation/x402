package org.x402.mechanisms.cardano.exact.client;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;
import org.x402.mechanisms.cardano.exact.masumi.MasumiCommitmentInput;
import org.x402.mechanisms.cardano.exact.masumi.MasumiIssue;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;
import org.x402.mechanisms.cardano.signer.ClientCardanoSignerConfig;
import org.x402.mechanisms.cardano.signer.MnemonicClientCardanoSigner;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.StubWallet;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Java-built payloads for the default, script and masumi methods pass the Java facilitator's
 * verify (rules 1–9 plus method checks) against a chain stub holding the wallet's UTxOs; the
 * lock datum equals the one the TypeScript SDK builds, byte for byte; nothing is ever broadcast.
 */
class CardanoClientAcceptanceTest {

  static final String MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice";
  static final String NETWORK = "cardano:preprod";
  static final long NOW = Vectors.now();
  static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(NOW), ZoneOffset.UTC);
  static final String USDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
  static final String PAY_TO = new Account(Networks.testnet(), MNEMONIC, 1).baseAddress();
  static final String WALLET = TxBuilder.walletAddress();

  private final StubWallet wallet =
      new StubWallet()
          .utxo(TxBuilder.hash32(0x31), 0, WALLET, 20_000_000, Map.of())
          .utxo(TxBuilder.hash32(0x32), 1, WALLET, 5_000_000, Map.of(USDM, BigInteger.valueOf(10_000_000)));
  private final StubBackend chain = new StubBackend();

  CardanoClientAcceptanceTest() {
    chain.slot = CardanoNetworks.currentSlot(NETWORK, CLOCK);
    wallet.publishTo(chain);
  }

  private ExactCardanoClientScheme client() {
    return new ExactCardanoClientScheme(
        new MnemonicClientCardanoSigner(
            ClientCardanoSignerConfig.builder()
                .mnemonic(MNEMONIC)
                .network(NETWORK)
                .walletProvider(wallet)
                .clock(CLOCK)
                .build()));
  }

  private PaymentPayload pay(PaymentRequirements requirements) {
    SchemeNetworkClient.PaymentPayloadResult result =
        client().createPaymentPayload(2, requirements, SchemeNetworkClient.PaymentPayloadContext.EMPTY);
    assertThat(result.x402Version()).isEqualTo(2);
    assertThat(result.payload()).containsOnlyKeys("transaction", "nonce");
    return new PaymentPayload(2, ResourceInfo.of("https://api.example.com/jobs"), requirements, result.payload(), null);
  }

  private VerifyResponse verify(PaymentPayload payload) {
    return new ExactCardanoFacilitatorScheme(chain).verify(payload, payload.accepted(), FacilitatorContext.EMPTY);
  }

  private static DecodedCardanoTransaction decoded(PaymentPayload payload) {
    return CardanoTransactionDecoder.decode((String) payload.payload().get("transaction"));
  }

  @Test
  void aDefaultLovelacePaymentPassesFacilitatorVerify() {
    PaymentRequirements req = new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", PAY_TO, 600, Map.of());
    PaymentPayload payload = pay(req);

    VerifyResponse result = verify(payload);

    assertThat(result.isValid()).as(String.valueOf(result)).isTrue();
    assertThat(result.payer()).isEqualTo(WALLET);
    DecodedCardanoTransaction tx = decoded(payload);
    assertThat(payload.payload().get("nonce")).isEqualTo(TxBuilder.hash32(0x31) + "#0");
    assertThat(tx.inputs()).contains(TxBuilder.hash32(0x31) + "#0");
    assertThat(tx.balanceChangingOperations()).isEmpty();
    assertThat(tx.networkId()).isNull();
    assertThat(CardanoNetworks.slotToPosixMs(NETWORK, tx.ttlSlot()))
        .isLessThanOrEqualTo(BigInteger.valueOf(NOW + 600_000));
    assertThat(chain.submitted).isEmpty();
    assertThat(wallet.utxoCalls.get()).isEqualTo(1);
  }

  @Test
  void aNativeAssetPaymentSelectsTheTokenInputAndPassesVerify() {
    PaymentRequirements req = new PaymentRequirements("exact", NETWORK, USDM, "1500000", PAY_TO, 300, Map.of("assetTransferMethod", "default"));
    PaymentPayload payload = pay(req);

    assertThat(verify(payload).isValid()).isTrue();
    DecodedCardanoTransaction tx = decoded(payload);
    assertThat(tx.inputs()).contains(TxBuilder.hash32(0x32) + "#1");
    DecodedCardanoTransaction.Output out = tx.outputs().stream().filter(o -> o.address().equals(PAY_TO)).findFirst().orElseThrow();
    assertThat(out.assets()).containsEntry(USDM, BigInteger.valueOf(1_500_000));
  }

  @Test
  void aScriptPaymentCarriesTheDeclaredDatumAndPassesVerify() {
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethod", "script");
    extra.put("script", Map.of("type", "plutusV3", "code", "4d01000033222220051200120011"));
    extra.put("datum", "d8799f4568656c6c6f182aff");
    String scriptAddress = CardanoAddresses.enterpriseScriptAddress(NETWORK, ScriptAddresses.deriveScriptHashHex(extra));
    PaymentRequirements req = new PaymentRequirements("exact", NETWORK, "lovelace", "3000000", scriptAddress, 600, extra);
    PaymentPayload payload = pay(req);

    assertThat(verify(payload).isValid()).isTrue();
    DecodedCardanoTransaction.Output out =
        decoded(payload).outputs().stream().filter(o -> o.address().equals(scriptAddress)).findFirst().orElseThrow();
    assertThat(out.datum()).isEqualTo("d8799f4568656c6c6f182aff");
  }

  static PaymentRequirements masumiQuote(String asset, String amount) {
    long payBy = NOW + 590_000;
    return MasumiIssue.issue(
        MasumiIssue.Input.builder()
            .network(NETWORK)
            .asset(asset)
            .amount(amount)
            .maxTimeoutSeconds(600)
            .sellerAddress(MasumiFixtures.SELLER.sellerAddress())
            .signTerms(MasumiFixtures.SELLER::signTerms)
            .commitment(List.of(new MasumiCommitmentInput("resource", "jcs", "application/json", Map.of("url", "https://api.example.com/jobs"), true)))
            .payByTime(Long.toString(payBy))
            .submitResultTime(Long.toString(payBy + 15 * 60_000))
            .unlockTime(Long.toString(payBy + 35 * 60_000))
            .externalDisputeUnlockTime(Long.toString(payBy + 55 * 60_000))
            .clock(CLOCK)
            .build());
  }

  @Test
  void aMasumiLockPassesFacilitatorVerify() {
    PaymentRequirements req = masumiQuote("lovelace", "5000000");
    PaymentPayload payload = pay(req);

    VerifyResponse result = verify(payload);

    assertThat(result.isValid()).as(String.valueOf(result)).isTrue();
    DecodedCardanoTransaction tx = decoded(payload);
    assertThat(CardanoNetworks.slotToPosixMs(NETWORK, tx.ttlSlot()))
        .isLessThanOrEqualTo(new BigInteger(MasumiSchema.validate(req.extra(), NETWORK).extra().terms().payByTime()));
  }

  @Test
  void aMasumiTokenLockCarriesCollateralAndPassesVerify() {
    PaymentRequirements req = masumiQuote(USDM, "7");
    PaymentPayload payload = pay(req);

    assertThat(verify(payload).isValid()).isTrue();
    DecodedCardanoTransaction.Output escrow =
        decoded(payload).outputs().stream().filter(o -> o.address().equals(req.payTo())).findFirst().orElseThrow();
    assertThat(escrow.assets()).containsExactly(Map.entry(USDM, BigInteger.valueOf(7)));
    assertThat(escrow.coin()).isGreaterThanOrEqualTo(BigInteger.valueOf(1_435_230));
  }

  @Test
  void theLockDatumEqualsTheTypeScriptOne() {
    JsonNode datum = Vectors.load("masumi-digests.json").get("datum");
    PaymentRequirements req = Vectors.requirements(datum.get("requirements"));
    String buyer = Vectors.fixture("12-masumi-happy").get("expected").get("payer").asText();

    MasumiLock.Lock lock =
        MasumiLock.build(
            MasumiSchema.validate(req.extra(), NETWORK).extra(),
            buyer,
            "lovelace",
            new BigInteger(req.amount()),
            BigInteger.valueOf(4310),
            MasumiBuyerInput.NONE);

    assertThat(HexFormat.of().formatHex(PlutusEncoding.encode(lock.datum()))).isEqualTo(datum.get("datumHex").asText());
    assertThat(lock.lockedLovelace()).isEqualTo(new BigInteger(req.amount()).add(lock.collateralLovelace()));
  }

  @Test
  void theSchemeAdvertisesUsdmAsTheOnlyDefaultAsset() {
    ExactCardanoClientScheme scheme = client();
    assertThat(scheme.scheme()).isEqualTo("exact");
    assertThat(scheme.findDefaultAsset(USDM, NETWORK).symbol()).isEqualTo("USDM");
    assertThat(scheme.findDefaultAsset(USDM.toUpperCase(), "cip34:0-1")).isNotNull();
    assertThat(scheme.findDefaultAsset("lovelace", NETWORK)).isNull();
    assertThat(scheme.findDefaultAsset(USDM, "cardano:preview")).isNull();
  }
}
