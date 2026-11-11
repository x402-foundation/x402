package org.x402.mechanisms.cardano.parity;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.utils.Jcs;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorOptions;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDatum;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeploymentClaim;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDigests;
import org.x402.mechanisms.cardano.exact.masumi.MasumiExtra;
import org.x402.mechanisms.cardano.exact.masumi.MasumiIdentifier;
import org.x402.mechanisms.cardano.exact.masumi.MasumiRegistryClaim;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSellerAuthorization;
import org.x402.mechanisms.cardano.exact.masumi.MasumiVerifier;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Work package B8-gaps, Masumi part: the app's Masumi digest, identifier, security and transfer
 * verifier tests that no earlier SDK test pinned for this input or arm. Each test names its app
 * source (file under {@code service/verification/method/masumi}).
 */
class AppB8MasumiGapsTest {

  private static final String PREPROD = "cardano:preprod";
  private static final String REGISTRY = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";

  private final PaymentRequirements quote = MasumiFixtures.issue(b -> {});
  private final PlutusData datum = MasumiDatum.build(MasumiFixtures.lockInput(quote, 0));

  // ------------------------------------------------------------------ helpers

  private static PlutusData field(PlutusData root, int index) {
    return PlutusEncoding.fields(root).get(index);
  }

  private static MasumiVerifier.Check lock(PaymentRequirements q, byte[] datumBytes, long coin,
      Map<String, BigInteger> assets, BigInteger coinsPerUtxoByte) {
    DecodedCardanoTransaction tx = MasumiFixtures.lock(q.payTo(), datumBytes, coin, assets, false,
        MasumiFixtures.ttlBeforePayBy(), List.of(MasumiFixtures.BUYER_KEY_HASH));
    return MasumiVerifier.verifyLock(q.extra(), q, tx,
        new MasumiVerifier.LockContext(MasumiFixtures.BUYER, coinsPerUtxoByte, null, null, null));
  }

  private MasumiVerifier.Check lock(byte[] datumBytes, long coin) {
    return lock(quote, datumBytes, coin, Map.of(), null);
  }

  private static void assertFails(MasumiVerifier.Check check, String reason, String detail) {
    assertThat(check.ok()).as(reason + " " + detail).isFalse();
    assertThat(check.reason()).isEqualTo(reason);
    assertThat(check.detail()).isEqualTo(detail);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> terms(Map<String, Object> extra) {
    return (Map<String, Object>) extra.get("terms");
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> commitment(Map<String, Object> extra) {
    return (Map<String, Object>) extra.get("inputCommitment");
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> firstPart(Map<String, Object> extra) {
    return ((List<Map<String, Object>>) commitment(extra).get("parts")).get(0);
  }

  /** Recomputes the commitment, input hash, seller signature and identifier of a mutated extra. */
  private static PaymentRequirements resign(PaymentRequirements base, Map<String, Object> extra) {
    String inputHash = MasumiDigests.computeInputHash(commitment(extra));
    commitment(extra).put("digest", inputHash);
    terms(extra).put("inputHash", inputHash);
    String digest = MasumiDigests.termsDigest(base.withExtra(extra));
    MasumiSellerAuthorization authorization =
        MasumiFixtures.SELLER.signTerms(MasumiFixtures.SELLER.sellerAddress(), digest);
    String key = authorization.key().toLowerCase();
    String signature = authorization.signature().toLowerCase();
    extra.put("referenceKey", key);
    extra.put("referenceSignature", signature);
    Object agent = terms(extra).get("agentIdentifier");
    extra.put("blockchainIdentifier", MasumiIdentifier.encode(new MasumiIdentifier.Parts(
        (String) terms(extra).get("sellerNonce"), agent instanceof String a ? a : "",
        (String) terms(extra).get("buyerNonce"), signature, key, base.payTo())));
    return base.withExtra(extra);
  }

  private static MasumiVerifier.Authorization authorize(PaymentRequirements q, MasumiVerifier.AuthorizationOptions o) {
    return MasumiVerifier.verifyAuthorization(MasumiFixtures.extra(q), q, o);
  }

  // ============================================================ 14 + GP MasumiDigestsTest

  /** App MasumiDigestsTest#signedAgentIdentifierOmittedNullAndEmptyRemainDistinct (:54-64). */
  @Test
  void anOmittedANullAndAnEmptyAgentIdentifierSignDifferentTerms() {
    Map<String, Object> extra = MasumiFixtures.mutableExtra(quote);
    terms(extra).remove("agentIdentifier");
    String omitted = MasumiDigests.termsDigest(quote.withExtra(extra));
    terms(extra).put("agentIdentifier", null);
    String explicitNull = MasumiDigests.termsDigest(quote.withExtra(extra));
    terms(extra).put("agentIdentifier", "");
    String empty = MasumiDigests.termsDigest(quote.withExtra(extra));

    assertThat(List.of(omitted, explicitNull, empty)).doesNotHaveDuplicates();
  }

  /** GP MasumiDigestsTest#confirmationPolicyIsOutsideSellerSignature (before/after equality). */
  @Test
  void theConfirmationPolicyIsOutsideTheSellerSignature() {
    String before = MasumiDigests.termsDigest(quote);
    PaymentRequirements stricter = quote.withExtra("confirmationPolicy", Map.of("l1Confirmations", 20));

    assertThat(MasumiDigests.termsDigest(stricter)).isEqualTo(before);
    assertThat(MasumiDigests.computeTermsDigest(MasumiDigests.buildSignedTerms(MasumiFixtures.extra(stricter), stricter)))
        .isEqualTo(before);
  }

  /** GP MasumiDigestsTest#jcsSortsKeysAndIsIndependentOfInsertionOrder. */
  @Test
  void jcsSortsKeysAndIsIndependentOfInsertionOrder() {
    Map<String, Object> a = new LinkedHashMap<>();
    a.put("b", 1);
    a.put("a", List.of(1, 2));
    Map<String, Object> b = new LinkedHashMap<>();
    b.put("a", List.of(1, 2));
    b.put("b", 1);

    assertThat(Jcs.canonicalize(a)).isEqualTo(Jcs.canonicalize(b)).isEqualTo("{\"a\":[1,2],\"b\":1}");
    assertThat(MasumiDigests.commitmentPartDigest("jcs", a)).isEqualTo(MasumiDigests.commitmentPartDigest("jcs", b));
  }

  // ============================================================ GP MasumiIdentifierTest

  /** GP MasumiIdentifierTest#rejectsMalformedIdentifiers: empty, odd length and non-hex. */
  @Test
  void emptyOddLengthAndNonHexIdentifiersDoNotDecode() {
    assertThat(MasumiIdentifier.decode("")).isNull();
    assertThat(MasumiIdentifier.decode("abc")).isNull();
    assertThat(MasumiIdentifier.decode("ZZZZ")).isNull();
  }

  // ============================================================ 15 MasumiTransferVerifierTest

  /**
   * App MasumiTransferVerifierTest#decoderCapturesOnChainInlineDatumLength (:163-173). The SDK has
   * no datum-length accessor: it exposes the on-chain inline datum itself, whose length the min-UTXO
   * rule reads. Pin that the decoder returns the exact bytes put on chain (not a re-encoding) and
   * none for the change output.
   */
  @Test
  void theDecoderKeepsTheOnChainInlineDatumBytesExactly() {
    byte[] datumBytes = PlutusEncoding.encode(datum);
    String tx = TxBuilder.create().input(TxBuilder.hash32(0xaa), 0)
        .output(quote.payTo(), 5_000_000, Map.of(), datumBytes, false)
        .output(MasumiFixtures.BUYER, 4_000_000, Map.of(), null, false)
        .fee(200_000).ttl(MasumiFixtures.ttlBeforePayBy()).signWith(TxBuilder.WALLET).build();

    DecodedCardanoTransaction decoded = CardanoTransactionDecoder.decode(tx);

    assertThat(decoded.outputs().get(0).datum()).isEqualTo(java.util.HexFormat.of().formatHex(datumBytes));
    assertThat(decoded.outputs().get(0).datum().length() / 2).isEqualTo(datumBytes.length).isPositive();
    assertThat(decoded.outputs().get(1).datum()).isNull();
  }

  // ============================================================ 16 MasumiTransferVerifierTest

  /**
   * App MasumiTransferVerifierTest#doesNotMatchBuyerReturnAddress (:307-317). The buyer return
   * address is buyer-chosen: the quote cannot declare it, and a datum carrying one is accepted.
   */
  @Test
  void aBuyerChosenReturnAddressInTheDatumIsAccepted() {
    var base = MasumiFixtures.lockInput(quote, 0);
    for (String returnAddress : List.of(
        MasumiFixtures.BUYER, otherAddress())) {
      var withReturn = new MasumiDatum.LockInput(base.buyerAddress(), base.sellerAddress(), returnAddress,
          base.sellerReturnAddress(), base.referenceKey(), base.referenceSignature(), base.sellerNonce(),
          base.buyerNonce(), base.agentIdentifier(), base.collateralReturnLovelace(), base.inputHash(),
          base.payByTime(), base.submitResultTime(), base.unlockTime(), base.externalDisputeUnlockTime());
      MasumiVerifier.Check check = lock(PlutusEncoding.encode(MasumiDatum.build(withReturn)), 5_000_000);
      assertThat(check.ok()).as(returnAddress + " " + check.reason() + " " + check.detail()).isTrue();
    }
  }

  private static String otherAddress() {
    return new com.bloxbean.cardano.client.account.Account(Networks.testnet(),
        "test walk nut penalty hip pave soap entry language right filter choice", 5).baseAddress();
  }

  // ============================================================ GP MasumiTransferVerifierTest

  /** GP MasumiTransferVerifierTest#rejectsWrongFieldCount (:100-103). */
  @Test
  void aDatumWithTheWrongFieldCountIsInvalid() {
    List<PlutusData> fields = new ArrayList<>(PlutusEncoding.fields(datum));
    for (PlutusData broken : List.of(
        PlutusEncoding.constr(0, fields.subList(0, 18).toArray(new PlutusData[0])),
        PlutusEncoding.constr(0, concat(fields, BigIntPlutusData.of(0))))) {
      assertFails(lock(PlutusEncoding.encode(broken), 5_000_000), CardanoErrors.MASUMI_DATUM_INVALID,
          "datum does not match masumi.vested_pay.v2");
    }
  }

  private static PlutusData[] concat(List<PlutusData> fields, PlutusData extra) {
    List<PlutusData> all = new ArrayList<>(fields);
    all.add(extra);
    return all.toArray(new PlutusData[0]);
  }

  /** GP MasumiTransferVerifierTest#rejectsNonIntegerCooldown (:119-122), seller and buyer cooldown. */
  @Test
  void aCooldownThatIsNotAnIntegerIsInvalid() {
    for (int index : new int[] {16, 17}) {
      byte[] broken = MasumiFixtures.withField(datum, index, PlutusEncoding.bytes("00"));
      assertThat(lock(broken, 5_000_000).ok()).as("field " + index).isFalse();
      assertThat(lock(broken, 5_000_000).reason()).as("field " + index)
          .isEqualTo(CardanoErrors.MASUMI_DATUM_INVALID);
    }
  }

  /** GP MasumiTransferVerifierTest#rejectsEscrowAsBuyerReturnAddress (:185-190). */
  @Test
  void theEscrowAsTheBuyerReturnAddressIsInvalid() {
    String escrowHash = CardanoAddresses.scriptPaymentCredentialHex(quote.payTo());
    PlutusData escrow =
        PlutusEncoding.constr(0, PlutusEncoding.constr(1, PlutusEncoding.bytes(escrowHash)), PlutusEncoding.constr(1));

    MasumiVerifier.Check check =
        lock(MasumiFixtures.withField(datum, 1, PlutusEncoding.constr(0, escrow)), 5_000_000);

    assertFails(check, CardanoErrors.MASUMI_DATUM_INVALID, "buyer_return_address is a script payment credential");
  }

  /** GP MasumiTransferVerifierTest#rejectsCollateralAboveLockedCoin (:225-228). */
  @Test
  void aCollateralAboveTheLockedCoinIsACollateralFailure() {
    PlutusData sixMillion = MasumiDatum.build(MasumiFixtures.lockInput(quote, 6_000_000));

    MasumiVerifier.Check check = lock(PlutusEncoding.encode(sixMillion), 5_000_000);

    assertFails(check, CardanoErrors.MASUMI_COLLATERAL, "locked 5000000 lovelace, expected 11000000");
  }

  /** GP MasumiTransferVerifierTest#rejectsHexFieldMismatch (:290-293), reference_key. */
  @Test
  void aReferenceKeyThatDiffersFromTheQuoteIsAMismatch() {
    assertFails(lock(MasumiFixtures.withField(datum, 4, PlutusEncoding.bytes("ffffffff")), 5_000_000),
        CardanoErrors.MASUMI_DATUM_MISMATCH, "reference_key");
  }

  /** GP MasumiTransferVerifierTest#rejectsTimeFieldMismatch (:295-298), unlock_time. */
  @Test
  void anUnlockTimeThatDiffersFromTheQuoteIsAMismatch() {
    // Slack on both sides of unlock_time so only the quote comparison can fire.
    PaymentRequirements slack = MasumiFixtures.issue(b -> b
        .unlockTime(Long.toString(MasumiFixtures.PAY_BY + 25 * 60_000))
        .externalDisputeUnlockTime(Long.toString(MasumiFixtures.PAY_BY + 45 * 60_000)));
    PlutusData slackDatum = MasumiDatum.build(MasumiFixtures.lockInput(slack, 0));
    BigInteger unlock = new BigInteger(MasumiFixtures.extra(slack).terms().unlockTime());

    MasumiVerifier.Check check = lock(slack,
        MasumiFixtures.withField(slackDatum, 14, BigIntPlutusData.of(unlock.add(BigInteger.valueOf(1_000)))),
        5_000_000, Map.of(), null);

    assertFails(check, CardanoErrors.MASUMI_DATUM_MISMATCH, "unlock_time");
  }

  // ============================================================ GP MasumiSecurityTest

  /**
   * GP MasumiSecurityTest#hashesExplicitJcsNullButAllowsOmittedContent (:60-76), the part the SDK
   * shares with the app: a part whose content is omitted is allowed by a verifier and refused by a
   * client that requires all content. The app additionally hashed an explicit JCS {@code null}
   * content against the part digest; the SDK (like the TypeScript {@code part.content ??}) treats it
   * as absent -- reported as a finding, so only the shared arms are asserted here.
   */
  @Test
  void anOmittedOrNullContentIsUnverifiableSoAClientRequiringContentRefusesIt() {
    Map<String, Object> extra = MasumiFixtures.mutableExtra(quote);
    firstPart(extra).put("digest", "ab".repeat(32));
    firstPart(extra).remove("content");
    PaymentRequirements omitted = resign(quote, extra);
    var requireContent = new MasumiVerifier.AuthorizationOptions(null, null, null, null, true, null,
        java.time.Clock.systemUTC());

    assertThat(authorize(omitted, MasumiVerifier.AuthorizationOptions.NONE).ok()).isTrue();
    MasumiVerifier.Authorization strict = authorize(omitted, requireContent);
    assertThat(strict.reason()).isEqualTo(CardanoErrors.MASUMI_COMMITMENT);
    assertThat(strict.detail()).isEqualTo("part body carries no content to verify its digest against");

    firstPart(extra).put("content", null);
    PaymentRequirements explicitNull = resign(quote, extra);
    assertThat(authorize(explicitNull, requireContent).reason()).isEqualTo(CardanoErrors.MASUMI_COMMITMENT);

    // With real content the wrong digest is caught.
    firstPart(extra).put("content", Map.of("q", 1));
    PaymentRequirements wrongDigest = resign(quote, extra);
    assertThat(authorize(wrongDigest, MasumiVerifier.AuthorizationOptions.NONE).detail())
        .isEqualTo("part body digest mismatch");
  }

  /** GP MasumiSecurityTest#requiresExactAdaIncludingStructuralCollateral: the +-1 boundaries. */
  @Test
  void theLockedLovelaceMustEqualAmountPlusCollateralExactly() {
    PaymentRequirements small = MasumiFixtures.issue(b -> b.amount("1500000"));
    byte[] d = PlutusEncoding.encode(MasumiDatum.build(MasumiFixtures.lockInput(small, 1_435_230)));

    assertThat(lock(small, d, 2_935_230, Map.of(), null).ok()).isTrue();
    for (long coin : new long[] {2_935_229L, 2_935_231L}) {
      MasumiVerifier.Check check = lock(small, d, coin, Map.of(), null);
      assertThat(check.reason()).as("coin " + coin).isEqualTo(CardanoErrors.MASUMI_COLLATERAL);
    }
  }

  /** GP MasumiSecurityTest#buyerMayChooseADifferentStakeCredentialButMustWitnessPaymentKey. */
  @Test
  void aBuyerMayChooseAnotherStakeCredentialButMustWitnessTheirPaymentKey() {
    Credential payment = new Address(MasumiFixtures.BUYER).getPaymentCredential().orElseThrow();
    String otherStake =
        AddressProvider.getBaseAddress(payment, Credential.fromKey(new byte[28]), Networks.testnet()).toBech32();
    var base = MasumiFixtures.lockInput(quote, 0);
    var input = new MasumiDatum.LockInput(otherStake, base.sellerAddress(), null, base.sellerReturnAddress(),
        base.referenceKey(), base.referenceSignature(), base.sellerNonce(), base.buyerNonce(),
        base.agentIdentifier(), base.collateralReturnLovelace(), base.inputHash(), base.payByTime(),
        base.submitResultTime(), base.unlockTime(), base.externalDisputeUnlockTime());
    byte[] d = PlutusEncoding.encode(MasumiDatum.build(input));

    assertThat(lock(d, 5_000_000).ok()).isTrue();

    DecodedCardanoTransaction unwitnessed = MasumiFixtures.lock(quote.payTo(), d, 5_000_000, Map.of(), false,
        MasumiFixtures.ttlBeforePayBy(), List.of());
    MasumiVerifier.Check check = MasumiVerifier.verifyLock(quote.extra(), quote, unwitnessed,
        new MasumiVerifier.LockContext(MasumiFixtures.BUYER, null, null, null, null));
    assertFails(check, CardanoErrors.MASUMI_DATUM_MISMATCH, "no witness for the buyer credential");
  }

  /** GP MasumiSecurityTest#rejectsScriptStakeCredentialsInBuyerDatum. */
  @Test
  void aScriptStakeCredentialInTheBuyerDatumIsInvalid() {
    PlutusData scriptStakeBuyer = PlutusEncoding.constr(
        0,
        PlutusEncoding.constr(0, PlutusEncoding.bytes(MasumiFixtures.BUYER_KEY_HASH)),
        PlutusEncoding.constr(0, PlutusEncoding.constr(0, PlutusEncoding.constr(1, PlutusEncoding.bytes(TxBuilder.hash28(8))))));

    assertFails(lock(MasumiFixtures.withField(datum, 0, scriptStakeBuyer), 5_000_000),
        CardanoErrors.MASUMI_DATUM_INVALID, "buyer is a script stake credential");
  }

  /** GP MasumiSecurityTest#explicitDeploymentNeedsApprovalEvenIfItRestatesCanonicalParameters. */
  @Test
  void aRestatedCanonicalDeploymentStillNeedsApproval() {
    MasumiDeployment canonical = MasumiDeployment.DEFAULT;
    PaymentRequirements restated = MasumiFixtures.issue(b -> b.deployment(
        new MasumiDeployment(canonical.requiredAdmins(), canonical.adminVkeys(), canonical.cooldownPeriod())));
    assertThat(restated.payTo()).isEqualTo(quote.payTo());

    MasumiVerifier.Authorization unapproved = authorize(restated, MasumiVerifier.AuthorizationOptions.NONE);
    assertThat(unapproved.ok()).isFalse();
    assertThat(unapproved.reason()).isEqualTo(CardanoErrors.MASUMI_DEPLOYMENT);
    assertThat(unapproved.detail()).isEqualTo("custom deployment requires explicit application approval");

    String escrowHash = MasumiBlueprint.escrowScriptHash(canonical);
    var allowlisted = new MasumiVerifier.AuthorizationOptions(null, null, null, null, false, null,
        java.time.Clock.systemUTC(), Set.of(escrowHash));
    assertThat(authorize(restated, allowlisted).ok()).isTrue();
  }

  /** GP MasumiSecurityTest#deploymentValidatorExplicitlyApprovesTrustDomain: what the validator sees. */
  @Test
  void theDeploymentValidatorSeesTheNetworkEscrowAndDeployment() {
    MasumiDeployment canonical = MasumiDeployment.DEFAULT;
    PaymentRequirements restated = MasumiFixtures.issue(b -> b.deployment(canonical));
    AtomicReference<MasumiDeploymentClaim> seen = new AtomicReference<>();

    var approving = new MasumiVerifier.AuthorizationOptions(null, null, claim -> {
      seen.set(claim);
      return true;
    }, null, false, null, java.time.Clock.systemUTC());
    assertThat(authorize(restated, approving).ok()).isTrue();
    assertThat(seen.get()).isEqualTo(new MasumiDeploymentClaim(PREPROD, restated.payTo(), canonical));

    var rejecting = new MasumiVerifier.AuthorizationOptions(null, null, claim -> false, null, false, null,
        java.time.Clock.systemUTC());
    assertThat(authorize(restated, rejecting).reason()).isEqualTo(CardanoErrors.MASUMI_DEPLOYMENT);
  }

  /**
   * GP MasumiSecurityTest#registryValidatorReceivesResourceTermsRequirementsAndNetworkAfterSignature.
   * The SDK claim carries the agent id, seller, network, amount, asset and resource (the app's
   * claim also carried the whole requirements and terms objects). The validator runs only after the
   * seller signature verified, and its rejection or failure is an agent-identifier failure.
   */
  @Test
  void theRegistryValidatorReceivesTheSignedClaimOnlyAfterTheSignatureVerified() {
    PaymentRequirements agent = MasumiFixtures.issue(b -> b.agentIdentifier(REGISTRY + "01"));
    ResourceInfo resource = ResourceInfo.of("https://seller.example/run");
    AtomicReference<MasumiRegistryClaim> seen = new AtomicReference<>();
    var accepting = new MasumiVerifier.AuthorizationOptions(claim -> {
      seen.set(claim);
      return true;
    }, resource, null, null, false, null, java.time.Clock.systemUTC());

    assertThat(authorize(agent, accepting).ok()).isTrue();
    assertThat(seen.get()).isEqualTo(new MasumiRegistryClaim(REGISTRY + "01", MasumiFixtures.SELLER.sellerAddress(),
        PREPROD, agent.amount(), agent.asset(), resource));

    var rejecting = new MasumiVerifier.AuthorizationOptions(claim -> false, resource, null, null, false, null,
        java.time.Clock.systemUTC());
    assertThat(authorize(agent, rejecting).reason()).isEqualTo(CardanoErrors.MASUMI_AGENT_IDENTIFIER);
    var unavailable = new MasumiVerifier.AuthorizationOptions(claim -> {
      throw new IllegalStateException("registry down");
    }, resource, null, null, false, null, java.time.Clock.systemUTC());
    org.assertj.core.api.Assertions.assertThatThrownBy(() -> authorize(agent, unavailable))
        .isInstanceOf(IllegalStateException.class);
    assertThat(authorize(agent, MasumiVerifier.AuthorizationOptions.NONE).reason())
        .isEqualTo(CardanoErrors.MASUMI_AGENT_IDENTIFIER);

    seen.set(null);
    MasumiExtra valid = MasumiFixtures.extra(agent);
    MasumiExtra badSignature = new MasumiExtra(valid.confirmationPolicy(), valid.areFeesSponsored(),
        valid.inputCommitment(), valid.terms(), valid.referenceKey(), "00".repeat(40), valid.blockchainIdentifier(),
        valid.deployment());
    MasumiVerifier.Authorization tampered = MasumiVerifier.verifyAuthorization(badSignature, agent, accepting);
    assertThat(tampered.ok()).isFalse();
    assertThat(tampered.reason()).isEqualTo(CardanoErrors.MASUMI_SELLER_SIGNATURE);
    assertThat(seen.get()).isNull();
  }

  /**
   * GP MasumiSecurityTest#registryValidatorReceivesResourceTermsRequirementsAndNetworkAfterSignature
   * at the scheme: an approving validator verifies the lock, a rejecting one is
   * {@code masumi_agent_identifier}, and one that throws never lets the lock through (the app mapped
   * the exception to the same agent-identifier code; the SDK scheme answers its generic
   * verification error).
   */
  @Test
  void aRegistryValidatorDecidesTheLockAtTheSchemeAndFailsClosed() {
    PaymentRequirements agent = MasumiFixtures.issue(b -> b.agentIdentifier(REGISTRY + "01"));
    byte[] d = PlutusEncoding.encode(MasumiDatum.build(MasumiFixtures.lockInput(agent, 0)));
    StubBackend backend = new StubBackend();
    long ttl = MasumiFixtures.ttlBeforePayBy();
    backend.slot = ttl - 300;
    String hash = TxBuilder.hash32(0xaa);
    backend.unspent(hash + "#0", MasumiFixtures.BUYER, 20_000_000, Map.of());
    String tx = TxBuilder.create().input(hash, 0)
        .output(agent.payTo(), 5_000_000, Map.of(), d, false)
        .output(MasumiFixtures.BUYER, 14_800_000, Map.of(), null, false)
        .fee(200_000).ttl(ttl).signWith(TxBuilder.WALLET).build();
    Map<String, Object> wire = new LinkedHashMap<>();
    wire.put("transaction", tx);
    wire.put("nonce", hash + "#0");
    var payload = new org.x402.core.types.PaymentPayload(2, ResourceInfo.of("https://seller.example/run"), agent, wire, null);

    java.util.function.Function<org.x402.mechanisms.cardano.exact.masumi.MasumiRegistryValidator,
        org.x402.core.types.VerifyResponse> verify =
        validator -> new ExactCardanoFacilitatorScheme(backend, null,
            ExactCardanoFacilitatorOptions.builder().registryValidator(validator).build())
            .verify(payload, agent, org.x402.core.FacilitatorContext.EMPTY);

    assertThat(verify.apply(claim -> true).isValid()).isTrue();
    assertThat(verify.apply(claim -> false).invalidReason()).isEqualTo(CardanoErrors.MASUMI_AGENT_IDENTIFIER);
    var thrown = verify.apply(claim -> {
      throw new IllegalStateException("registry down");
    });
    assertThat(thrown.isValid()).isFalse();
    assertThat(thrown.invalidReason()).isEqualTo(CardanoErrors.INVALID_PAYLOAD + "_verification_error");
  }

  /** The fixtures every test above mutates are themselves valid. */
  @Test
  void theBaselineLockIsValid() {
    assertThat(lock(PlutusEncoding.encode(datum), 5_000_000).ok()).isTrue();
    assertThat(MasumiSchema.validate(quote.extra(), PREPROD).ok()).isTrue();
  }
}
