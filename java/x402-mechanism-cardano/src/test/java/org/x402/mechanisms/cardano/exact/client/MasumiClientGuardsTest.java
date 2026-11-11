package org.x402.mechanisms.cardano.exact.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigInteger;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.exact.masumi.MasumiCommitmentInput;
import org.x402.mechanisms.cardano.exact.masumi.MasumiConstants;
import org.x402.mechanisms.cardano.exact.masumi.MasumiIssue;
import org.x402.mechanisms.cardano.signer.ClientCardanoSignerConfig;
import org.x402.mechanisms.cardano.signer.MnemonicClientCardanoSigner;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.StubWallet;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * A forged or hostile Masumi 402 is refused before the wallet is touched: the wallet provider sees
 * zero calls. The collateral ceiling needs the live
 * protocol parameters and is refused before any UTxO query.
 */
class MasumiClientGuardsTest {

  private static final String NETWORK = CardanoClientAcceptanceTest.NETWORK;
  private static final long NOW = CardanoClientAcceptanceTest.NOW;

  private final StubWallet wallet =
      new StubWallet().utxo(TxBuilder.hash32(0x41), 0, TxBuilder.walletAddress(), 50_000_000, Map.of());

  private ExactCardanoClientScheme client(Consumer<ClientCardanoSignerConfig.Builder> customize) {
    ClientCardanoSignerConfig.Builder b =
        ClientCardanoSignerConfig.builder()
            .mnemonic(CardanoClientAcceptanceTest.MNEMONIC)
            .network(NETWORK)
            .walletProvider(wallet)
            .clock(CardanoClientAcceptanceTest.CLOCK);
    customize.accept(b);
    return new ExactCardanoClientScheme(new MnemonicClientCardanoSigner(b.build()));
  }

  private String refusal(PaymentRequirements req, Consumer<ClientCardanoSignerConfig.Builder> customize) {
    try {
      client(customize).createPaymentPayload(2, req, SchemeNetworkClient.PaymentPayloadContext.EMPTY);
      throw new AssertionError("payment was not refused");
    } catch (IllegalArgumentException | IllegalStateException e) {
      return e.getMessage();
    }
  }

  private String refusal(PaymentRequirements req) {
    return refusal(req, b -> {});
  }

  private static PaymentRequirements quote(Consumer<MasumiIssue.Builder> customize) {
    long payBy = NOW + 590_000;
    MasumiIssue.Builder b =
        MasumiIssue.Input.builder()
            .network(NETWORK)
            .asset("lovelace")
            .amount("5000000")
            .maxTimeoutSeconds(600)
            .sellerAddress(MasumiFixtures.SELLER.sellerAddress())
            .signTerms(MasumiFixtures.SELLER::signTerms)
            .commitment(List.of(new MasumiCommitmentInput("resource", "jcs", null, Map.of("url", "u"), true)))
            .payByTime(Long.toString(payBy))
            .submitResultTime(Long.toString(payBy + 15 * 60_000))
            .unlockTime(Long.toString(payBy + 35 * 60_000))
            .externalDisputeUnlockTime(Long.toString(payBy + 55 * 60_000))
            .unsafeSkipPolicyChecks(true);
    customize.accept(b);
    return MasumiIssue.issue(b.build());
  }

  @Test
  void aForgedSellerSignatureIsRefusedBeforeTheWallet() {
    PaymentRequirements q = quote(b -> {});
    Map<String, Object> extra = new LinkedHashMap<>(q.extra());
    String sig = (String) extra.get("referenceSignature");
    extra.put("referenceSignature", sig.substring(0, sig.length() - 2) + (sig.endsWith("00") ? "01" : "00"));

    assertThat(refusal(q.withExtra(extra)))
        .isEqualTo("Masumi seller authorization failed: invalid_exact_cardano_requirements_masumi_seller_signature");
    assertThat(wallet.calls()).isZero();
  }

  @Test
  void aPayToThatIsNotTheEscrowIsRefusedBeforeTheWallet() {
    PaymentRequirements q = quote(b -> {}).withPayTo(CardanoClientAcceptanceTest.PAY_TO);

    assertThat(refusal(q))
        .startsWith("Masumi seller authorization failed: invalid_exact_cardano_requirements_masumi_deployment (derived escrow ");
    assertThat(wallet.calls()).isZero();
  }

  @Test
  void anExcessiveDeadlineIsRefusedBeforeTheWallet() {
    long far = NOW + 31L * 24 * 3600 * 1000;
    PaymentRequirements q = quote(b -> b.externalDisputeUnlockTime(Long.toString(far)));

    assertThat(refusal(q))
        .isEqualTo(
            "Masumi seller authorization failed: invalid_exact_cardano_payload_masumi_deadline (deadlines extend beyond the accepted horizon)");
    assertThat(wallet.calls()).isZero();
    // A buyer who accepts a longer horizon may pay it.
    var accepting = client(b -> b.masumiMaxDeadlineHorizonMs(BigInteger.valueOf(40L * 24 * 3600 * 1000)));
    assertThat(accepting.createPaymentPayload(2, q, SchemeNetworkClient.PaymentPayloadContext.EMPTY).payload()).containsKey("nonce");
  }

  @Test
  void schemaWindowAndBuyerInputGuards() {
    PaymentRequirements q = quote(b -> {});
    Map<String, Object> unknown = new LinkedHashMap<>(q.extra());
    unknown.put("memo", "x");
    assertThat(refusal(q.withExtra(unknown))).isEqualTo("Masumi payment requirements are invalid: extra has unknown field memo");

    PaymentRequirements expired = quote(b -> b.payByTime(Long.toString(NOW)).submitResultTime(Long.toString(NOW + 15 * 60_000)));
    assertThat(refusal(expired)).isEqualTo("Masumi client preflight failed: payByTime has expired");
    PaymentRequirements tooLate = quote(b -> b.maxTimeoutSeconds(60));
    assertThat(refusal(tooLate)).isEqualTo("Masumi client preflight failed: payByTime exceeds maxTimeoutSeconds");

    assertThat(refusal(q, b -> b.masumiBuyerInput(e -> new MasumiBuyerInput("addr_test1wbad"))))
        .isEqualTo("Masumi buyer return address must be a key-credential address on network");
    assertThat(refusal(q, b -> b.network("cardano:mainnet")))
        .isEqualTo("Signer configured for cardano:mainnet but asked to pay on cardano:preprod");
    assertThat(wallet.calls()).isZero();
  }

  @Test
  void unverifiablePartsAndRegistryClaimsAreRefused() {
    PaymentRequirements hidden =
        quote(b -> b.commitment(List.of(new MasumiCommitmentInput("body", "jcs", null, Map.of("q", 1), false))));
    assertThat(refusal(hidden))
        .isEqualTo(
            "Masumi seller authorization failed: invalid_exact_cardano_requirements_masumi_commitment (part body carries no content to verify its digest against)");
    assertThat(wallet.calls()).isZero();
    var withContent = client(b -> b.masumiRequestContent(Map.of("body", Map.of("q", 1))));
    assertThat(withContent.createPaymentPayload(2, hidden, SchemeNetworkClient.PaymentPayloadContext.EMPTY).payload())
        .containsKey("transaction");

    PaymentRequirements registered = quote(b -> b.agentIdentifier(MasumiConstants.REGISTRY_POLICY_ID + "00"));
    wallet.utxoCalls.set(0);
    wallet.parameterCalls.set(0);
    assertThat(refusal(registered))
        .isEqualTo(
            "Masumi seller authorization failed: invalid_exact_cardano_requirements_masumi_agent_identifier (registry claims require an independent on-network validator)");
    assertThat(wallet.calls()).isZero();
  }

  @Test
  void theCollateralCeilingIsCheckedBeforeAnyUtxoQuery() {
    String usdm = CardanoClientAcceptanceTest.USDM;
    PaymentRequirements token = quote(b -> b.asset(usdm).amount("7"));

    String message = refusal(token, b -> b.masumiMaxCollateralLovelace(BigInteger.valueOf(1_000_000)));

    assertThat(message).startsWith("Masumi client preflight failed: collateral ").endsWith(" exceeds the configured maximum 1000000");
    assertThat(wallet.utxoCalls.get()).isZero();
  }

  @Test
  void theSchemeRefusesMalformedRequirementsBeforeTheSigner() {
    var scheme = client(b -> {});
    String payTo = CardanoClientAcceptanceTest.PAY_TO;
    for (Map.Entry<PaymentRequirements, String> c :
        Map.of(
                new PaymentRequirements("exact", "eip155:1", "lovelace", "1", payTo, 60, null), "Unsupported Cardano network: eip155:1",
                new PaymentRequirements("exact", NETWORK, "lovelace", "1", "", 60, null), "Pay-to address is required",
                new PaymentRequirements("exact", NETWORK, "lovelace", "1", "stake1u", 60, null), "Invalid Cardano pay-to address: stake1u",
                new PaymentRequirements("exact", NETWORK, "", "1", payTo, 60, null), "Asset is required",
                new PaymentRequirements("exact", NETWORK, "LOVELACE", "1", payTo, 60, null), "Cardano asset must use canonical lowercase form: LOVELACE",
                new PaymentRequirements("exact", NETWORK, "lovelace", "", payTo, 60, null), "Amount is required",
                new PaymentRequirements("exact", NETWORK, "lovelace", "01", payTo, 60, null), "Amount must be a positive canonical integer, got: 01",
                new PaymentRequirements("exact", NETWORK, "lovelace", "1", payTo, 60, Map.of("confirmationPolicy", 1)),
                "Cardano payment requirements carry an invalid confirmation policy")
            .entrySet()) {
      assertThatThrownBy(() -> scheme.createPaymentPayload(2, c.getKey(), SchemeNetworkClient.PaymentPayloadContext.EMPTY))
          .hasMessage(c.getValue());
    }
    assertThat(wallet.calls()).isZero();
  }
}
