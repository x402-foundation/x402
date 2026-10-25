package org.x402.mechanisms.cardano.exact.masumi;

import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigInteger;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Every Masumi authorization and lock rule (spec Masumi rules) on hand-built locks.
 */
class MasumiVerifierTest {

  private static final BigInteger CPUB = BigInteger.valueOf(4310);
  private final PaymentRequirements quote = MasumiFixtures.issue(b -> {});
  private final PlutusData datum = MasumiDatum.build(MasumiFixtures.lockInput(quote, 0));

  private MasumiVerifier.Check lock(byte[] datumBytes, long coin, Map<String, BigInteger> assets) {
    return lock(quote, datumBytes, coin, assets, false, MasumiFixtures.ttlBeforePayBy(), List.of(MasumiFixtures.BUYER_KEY_HASH));
  }

  private static MasumiVerifier.Check lock(
      PaymentRequirements q,
      byte[] datumBytes,
      long coin,
      Map<String, BigInteger> assets,
      boolean refScript,
      Long ttl,
      List<String> vkeys) {
    DecodedCardanoTransaction tx = MasumiFixtures.lock(q.payTo(), datumBytes, coin, assets, refScript, ttl, vkeys);
    return MasumiVerifier.verifyLock(
        q.extra(), q, tx, new MasumiVerifier.LockContext(MasumiFixtures.BUYER, CPUB, null, null, null));
  }

  private static void assertFails(MasumiVerifier.Check check, String reason, String detail) {
    assertThat(check.ok()).as(reason + " " + detail).isFalse();
    assertThat(check.reason()).isEqualTo(reason);
    assertThat(check.detail()).isEqualTo(detail);
  }

  @Test
  void aWellFormedLockVerifies() {
    assertThat(lock(PlutusEncoding.encode(datum), 5_000_000, Map.of()).ok()).isTrue();
  }

  @Test
  void outputShapeRules() {
    byte[] d = PlutusEncoding.encode(datum);
    PaymentRequirements q = quote;
    DecodedCardanoTransaction none = MasumiFixtures.lock(TxBuilder.walletAddress(), d, 5_000_000, Map.of(), false, 1L, List.of());
    assertFails(
        MasumiVerifier.verifyLock(q.extra(), q, none, new MasumiVerifier.LockContext(MasumiFixtures.BUYER, CPUB, null, null, null)),
        "invalid_exact_cardano_payload_masumi_escrow_output_count",
        null);
    assertFails(lock(q, null, 5_000_000, Map.of(), false, 1L, List.of()), "invalid_exact_cardano_payload_masumi_datum_missing", null);
    assertFails(lock(q, d, 5_000_000, Map.of(), true, 1L, List.of()), "invalid_exact_cardano_payload_masumi_reference_script", null);
    assertFails(
        lock(PlutusEncoding.encode(PlutusEncoding.constr(0)), 5_000_000, Map.of()),
        "invalid_exact_cardano_payload_masumi_datum_invalid",
        "datum does not match masumi.vested_pay.v2");
    Map<String, Object> bad = new LinkedHashMap<>(q.extra());
    bad.put("x", 1);
    assertFails(
        MasumiVerifier.verifyLock(bad, q, MasumiFixtures.lock(q.payTo(), d, 1, Map.of(), false, 1L, List.of()),
            new MasumiVerifier.LockContext(MasumiFixtures.BUYER, CPUB, null, null, null)),
        "invalid_exact_cardano_requirements_masumi_schema",
        "extra has unknown field x");
  }

  @Test
  void datumInvariants() {
    String invalid = "invalid_exact_cardano_payload_masumi_datum_invalid";
    assertFails(lock(MasumiFixtures.withField(datum, 18, PlutusEncoding.constr(1)), 5_000_000, Map.of()), invalid, "state");
    assertFails(lock(MasumiFixtures.withField(datum, 11, PlutusEncoding.bytes("00")), 5_000_000, Map.of()), invalid, "result_hash");
    assertFails(lock(MasumiFixtures.withField(datum, 16, BigIntPlutusData.of(1)), 5_000_000, Map.of()), invalid, "cooldown");
    assertFails(lock(MasumiFixtures.withField(datum, 5, PlutusEncoding.bytes("00")), 5_000_000, Map.of()), invalid,
        "reference_signature shorter than 16 bytes");

    PlutusData scriptBuyer =
        PlutusEncoding.constr(0, PlutusEncoding.constr(1, PlutusEncoding.bytes(TxBuilder.hash28(7))), PlutusEncoding.constr(1));
    assertFails(lock(MasumiFixtures.withField(datum, 0, scriptBuyer), 5_000_000, Map.of()), invalid,
        "buyer is a script payment credential");
    PlutusData scriptStake =
        PlutusEncoding.constr(
            0,
            PlutusEncoding.constr(0, PlutusEncoding.bytes(TxBuilder.hash28(7))),
            PlutusEncoding.constr(0, PlutusEncoding.constr(0, PlutusEncoding.constr(1, PlutusEncoding.bytes(TxBuilder.hash28(8))))));
    assertFails(lock(MasumiFixtures.withField(datum, 2, scriptStake), 5_000_000, Map.of()), invalid,
        "seller is a script stake credential");
    PlutusData pointer =
        PlutusEncoding.constr(
            0,
            PlutusEncoding.constr(0, PlutusEncoding.bytes(TxBuilder.hash28(7))),
            PlutusEncoding.constr(0, PlutusEncoding.constr(1, BigIntPlutusData.of(1), BigIntPlutusData.of(2), BigIntPlutusData.of(3))));
    assertFails(lock(MasumiFixtures.withField(datum, 1, PlutusEncoding.constr(0, pointer)), 5_000_000, Map.of()), invalid,
        "buyer_return_address is a pointer stake reference");

    // An escrow-equal datum address is a script credential, refused by the form check first.
    String escrowHash = CardanoAddresses.scriptPaymentCredentialHex(quote.payTo());
    PlutusData escrow =
        PlutusEncoding.constr(0, PlutusEncoding.constr(1, PlutusEncoding.bytes(escrowHash)), PlutusEncoding.constr(1));
    assertFails(lock(MasumiFixtures.withField(datum, 3, PlutusEncoding.constr(0, escrow)), 5_000_000, Map.of()), invalid,
        "seller_return_address is a script payment credential");

    PlutusData buyerAddr = PlutusEncoding.fields(datum).get(0);
    assertFails(lock(MasumiFixtures.withField(datum, 3, PlutusEncoding.constr(0, buyerAddr)), 5_000_000, Map.of()), invalid,
        "buyer and seller payout targets are equal");
    assertFails(lock(MasumiFixtures.withField(datum, 13, BigIntPlutusData.of(MasumiFixtures.PAY_BY)), 5_000_000, Map.of()),
        "invalid_exact_cardano_payload_masumi_deadline", "deadline intervals below the minimum");
  }

  @Test
  void deadlineBuyerAndSellerRules() {
    byte[] d = PlutusEncoding.encode(datum);
    String mismatch = "invalid_exact_cardano_payload_masumi_datum_mismatch";
    assertFails(lock(quote, d, 5_000_000, Map.of(), false, null, List.of(MasumiFixtures.BUYER_KEY_HASH)),
        "invalid_exact_cardano_payload_masumi_deadline", "no validity upper bound");
    assertFails(lock(quote, d, 5_000_000, Map.of(), false, MasumiFixtures.ttlBeforePayBy() + 3600, List.of(MasumiFixtures.BUYER_KEY_HASH)),
        "invalid_exact_cardano_payload_masumi_deadline", "TTL is after pay_by_time");
    assertFails(lock(quote, d, 5_000_000, Map.of(), false, MasumiFixtures.ttlBeforePayBy(), List.of()), mismatch,
        "no witness for the buyer credential");
    DecodedCardanoTransaction tx =
        MasumiFixtures.lock(quote.payTo(), d, 5_000_000, Map.of(), false, MasumiFixtures.ttlBeforePayBy(), List.of());
    assertFails(
        MasumiVerifier.verifyLock(quote.extra(), quote, tx,
            new MasumiVerifier.LockContext(MasumiFixtures.SELLER.sellerAddress(), CPUB, null, null, null)),
        mismatch, "buyer does not control the nonce input");

    PlutusData buyerAddr = PlutusEncoding.fields(datum).get(0);
    assertFails(lock(MasumiFixtures.withField(datum, 2, buyerAddr), 5_000_000, Map.of()),
        "invalid_exact_cardano_payload_masumi_datum_invalid", "buyer and seller payout targets are equal");
    PlutusData other =
        PlutusEncoding.constr(0, PlutusEncoding.constr(0, PlutusEncoding.bytes(TxBuilder.hash28(9))), PlutusEncoding.constr(1));
    assertFails(lock(MasumiFixtures.withField(datum, 2, other), 5_000_000, Map.of()), mismatch, "seller");
    assertFails(lock(MasumiFixtures.withField(datum, 3, PlutusEncoding.constr(0, other)), 5_000_000, Map.of()), mismatch,
        "seller_return_address");
    assertFails(lock(MasumiFixtures.withField(datum, 7, PlutusEncoding.bytes("0102030405060708")), 5_000_000, Map.of()),
        mismatch, "buyer_nonce");
    assertFails(lock(MasumiFixtures.withField(datum, 15, BigIntPlutusData.of(MasumiFixtures.PAY_BY + 36 * 60_000)), 5_000_000, Map.of()),
        mismatch, "external_dispute_unlock_time");
  }

  @Test
  void valueRules() {
    String collateral = "invalid_exact_cardano_payload_masumi_collateral";
    assertFails(lock(PlutusEncoding.encode(datum), 5_000_001, Map.of()), collateral, "locked 5000001 lovelace, expected 5000000");
    assertFails(lock(MasumiFixtures.withField(datum, 9, BigIntPlutusData.of(-1)), 4_999_999, Map.of()), collateral,
        "collateral -1 below the floor");
    assertFails(lock(MasumiFixtures.withField(datum, 9, BigIntPlutusData.of(5)), 5_000_005, Map.of()), collateral,
        "collateral 5 below the floor");
    assertFails(lock(PlutusEncoding.encode(datum), 5_000_000, Map.of(TxBuilder.hash28(1) + ".01", BigInteger.ONE)),
        "invalid_exact_cardano_payload_masumi_asset", "escrow output carries extra native tokens");

    PaymentRequirements small = MasumiFixtures.issue(b -> b.amount("1000"));
    PlutusData smallDatum = MasumiDatum.build(MasumiFixtures.lockInput(small, 0));
    assertThat(
            lock(small, PlutusEncoding.encode(smallDatum), 1000, Map.of(), false, MasumiFixtures.ttlBeforePayBy(), List.of(MasumiFixtures.BUYER_KEY_HASH))
                .reason())
        .isEqualTo("invalid_exact_cardano_payload_masumi_min_utxo");

    String usdm = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
    PaymentRequirements token = MasumiFixtures.issue(b -> b.asset(usdm).amount("7"));
    long tokenCollateral = 5_000_000;
    PlutusData tokenDatum = MasumiDatum.build(MasumiFixtures.lockInput(token, tokenCollateral));
    List<String> keys = List.of(MasumiFixtures.BUYER_KEY_HASH);
    assertThat(lock(token, PlutusEncoding.encode(tokenDatum), tokenCollateral, Map.of(usdm, BigInteger.valueOf(7)), false,
            MasumiFixtures.ttlBeforePayBy(), keys)).isEqualTo(MasumiVerifier.Check.OK);
    assertThat(lock(token, PlutusEncoding.encode(tokenDatum), tokenCollateral, Map.of(usdm, BigInteger.valueOf(8)), false,
            MasumiFixtures.ttlBeforePayBy(), keys).reason())
        .isEqualTo("invalid_exact_cardano_payload_masumi_asset");
  }

  // ---------------------------------------------------------------- authorization

  private static MasumiVerifier.Authorization authorize(PaymentRequirements q, MasumiVerifier.AuthorizationOptions options) {
    return MasumiVerifier.verifyAuthorization(MasumiFixtures.extra(q), q, options);
  }

  private static MasumiVerifier.AuthorizationOptions options(
      MasumiRegistryValidator registry, ResourceInfo resource, MasumiDeploymentValidator deployment) {
    return new MasumiVerifier.AuthorizationOptions(registry, resource, deployment, null, false, null, Clock.systemUTC());
  }

  @Test
  void authorizationDeadlinesAndCommitment() {
    PaymentRequirements tight = MasumiFixtures.issue(b -> b.submitResultTime(Long.toString(MasumiFixtures.PAY_BY + 1)));
    assertThat(authorize(tight, MasumiVerifier.AuthorizationOptions.NONE).detail())
        .isEqualTo("deadline intervals below the minimum");

    Clock early = Clock.fixed(Instant.ofEpochMilli(MasumiFixtures.PAY_BY - 30L * 24 * 3600 * 1000 - 1), ZoneOffset.UTC);
    var horizon = new MasumiVerifier.AuthorizationOptions(null, null, null, null, false, MasumiConstants.MAX_DEADLINE_HORIZON_MS, early);
    assertThat(authorize(quote, horizon).detail()).isEqualTo("deadlines extend beyond the accepted horizon");

    PaymentRequirements hidden =
        MasumiFixtures.issue(
            b -> b.commitment(List.of(new MasumiCommitmentInput("body", "jcs", null, Map.of("q", 1), false))));
    assertThat(authorize(hidden, MasumiVerifier.AuthorizationOptions.NONE).ok()).isTrue();
    var strict = new MasumiVerifier.AuthorizationOptions(null, null, null, null, true, null, Clock.systemUTC());
    assertThat(authorize(hidden, strict).detail()).isEqualTo("part body carries no content to verify its digest against");
    var local = new MasumiVerifier.AuthorizationOptions(null, null, null, Map.of("body", Map.of("q", 1)), true, null, Clock.systemUTC());
    assertThat(authorize(hidden, local).ok()).isTrue();
    var wrong = new MasumiVerifier.AuthorizationOptions(null, null, null, Map.of("body", Map.of("q", 2)), true, null, Clock.systemUTC());
    assertThat(authorize(hidden, wrong).detail()).isEqualTo("part body digest mismatch");
    var rawWrong = new MasumiVerifier.AuthorizationOptions(null, null, null, Map.of("body", 5), true, null, Clock.systemUTC());
    assertThat(authorize(hidden, rawWrong).detail()).isEqualTo("part body digest mismatch");

    PaymentRequirements raw =
        MasumiFixtures.issue(b -> b.commitment(List.of(new MasumiCommitmentInput("raw", "raw", null, "aGk", false))));
    var badRaw = new MasumiVerifier.AuthorizationOptions(null, null, null, Map.of("raw", "a=="), false, null, Clock.systemUTC());
    assertThat(authorize(raw, badRaw).reason()).isEqualTo("invalid_exact_cardano_requirements_masumi_commitment");
  }

  @Test
  void authorizationDeploymentRules() {
    PaymentRequirements wrongPayTo = quote.withPayTo(TxBuilder.walletAddress());
    assertThat(authorize(wrongPayTo, MasumiVerifier.AuthorizationOptions.NONE).detail()).startsWith("derived escrow ");

    MasumiDeployment custom = new MasumiDeployment("1", List.of(TxBuilder.hash28(4)), "0");
    PaymentRequirements customQuote = MasumiFixtures.issue(b -> b.deployment(custom));
    assertThat(authorize(customQuote, MasumiVerifier.AuthorizationOptions.NONE).detail())
        .isEqualTo("custom deployment requires explicit application approval");
    assertThat(authorize(customQuote, options(null, null, claim -> false)).detail())
        .isEqualTo("custom deployment was not approved");
    assertThat(authorize(customQuote, options(null, null, claim -> claim.deployment().equals(custom))).ok()).isTrue();

    PaymentRequirements preview = quote.withExtra(quote.extra());
    PaymentRequirements onPreview =
        new PaymentRequirements("exact", "cardano:preview", preview.asset(), preview.amount(), preview.payTo(), 600, preview.extra());
    var schema = MasumiSchema.validate(onPreview.extra(), "cardano:preview");
    assertThat(schema.ok()).isTrue();
    assertThat(MasumiVerifier.verifyAuthorization(schema.extra(), onPreview, MasumiVerifier.AuthorizationOptions.NONE).detail())
        .isEqualTo("network has no canonical deployment; extra.deployment is required");
  }

  @Test
  void authorizationRegistryAndIdentifierRules() {
    String registered = MasumiConstants.REGISTRY_POLICY_ID + "0011";
    PaymentRequirements agent = MasumiFixtures.issue(b -> b.agentIdentifier(registered));
    ResourceInfo resource = ResourceInfo.of("https://api.example.com/jobs");
    assertThat(authorize(agent, MasumiVerifier.AuthorizationOptions.NONE).detail())
        .isEqualTo("registry claims require an independent on-network validator");
    assertThat(authorize(agent, options(c -> true, null, null)).detail())
        .isEqualTo("registry claims require the protected resource for endpoint validation");
    assertThat(authorize(agent, options(c -> false, resource, null)).detail())
        .isEqualTo("registry validation rejected the claim");
    assertThat(authorize(agent, options(c -> c.agentIdentifier().equals(registered) && c.resource() == resource, resource, null)).ok())
        .isTrue();
    PaymentRequirements stranger = MasumiFixtures.issue(b -> b.agentIdentifier("00ff"));
    assertThat(authorize(stranger, options(c -> true, resource, null)).detail())
        .isEqualTo("agentIdentifier does not carry the Masumi V2 registry policy id");
    assertThat(authorize(MasumiFixtures.issue(b -> b.agentIdentifier(null)), MasumiVerifier.AuthorizationOptions.NONE).ok()).isTrue();

    Map<String, Object> tampered = MasumiFixtures.mutableExtra(quote);
    MasumiExtra e = MasumiFixtures.extra(quote);
    tampered.put(
        "blockchainIdentifier",
        MasumiIdentifier.encode(
            new MasumiIdentifier.Parts(
                e.terms().sellerNonce(), "", "0102030405060708", e.referenceSignature(), e.referenceKey(), quote.payTo())));
    PaymentRequirements withIdentifier = quote.withExtra(tampered);
    assertThat(authorize(withIdentifier, MasumiVerifier.AuthorizationOptions.NONE).reason())
        .isEqualTo("invalid_exact_cardano_requirements_masumi_identifier");
  }

  @Test
  void theDeadlineCheckUsesTheNetworksSlotConfig() {
    byte[] d = PlutusEncoding.encode(datum);
    DecodedCardanoTransaction tx = MasumiFixtures.lock(quote.payTo(), d, 5_000_000, Map.of(), false,
        MasumiFixtures.ttlBeforePayBy(), List.of(MasumiFixtures.BUYER_KEY_HASH));
    var twoSecondSlots = new com.bloxbean.cardano.client.common.model.SlotConfig(2000, 86_400L, 1_655_769_600_000L);

    assertFails(MasumiVerifier.verifyLock(quote.extra(), quote, tx,
            new MasumiVerifier.LockContext(MasumiFixtures.BUYER, CPUB, null, null, null, twoSecondSlots)),
        "invalid_exact_cardano_payload_masumi_deadline", "TTL is after pay_by_time");
  }
}
