package org.x402.mechanisms.cardano.testing;

import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.fasterxml.jackson.core.type.TypeReference;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.exact.masumi.MasumiCommitmentInput;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDatum;
import org.x402.mechanisms.cardano.exact.masumi.MasumiExtra;
import org.x402.mechanisms.cardano.exact.masumi.MasumiIssue;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.server.CardanoSellerSigner;

/** Deterministic Masumi quotes, lock datums and decoded locks for branch tests. */
public final class MasumiFixtures {

  /** The seller wallet. */
  public static final CardanoSellerSigner SELLER =
      CardanoSellerSigner.fromMnemonic(
          "test walk nut penalty hip pave soap entry language right filter choice", "cardano:preprod", 3);
  /** The buyer: the TxBuilder wallet. */
  public static final String BUYER = TxBuilder.walletAddress();
  /** The buyer's payment key hash. */
  public static final String BUYER_KEY_HASH =
      HexFormat.of()
          .formatHex(com.bloxbean.cardano.client.crypto.Blake2bUtil.blake2bHash224(TxBuilder.WALLET.publicKeyBytes()));
  /** {@code payByTime} of every fixture quote. */
  public static final long PAY_BY = 1_785_756_000_000L;

  private MasumiFixtures() {}

  /**
   * A builder pre-filled with a valid preprod lovelace quote.
   *
   * @return the builder
   */
  public static MasumiIssue.Builder base() {
    return MasumiIssue.Input.builder()
        .network("cardano:preprod")
        .asset("lovelace")
        .amount("5000000")
        .maxTimeoutSeconds(600)
        .sellerAddress(SELLER.sellerAddress())
        .signTerms(SELLER::signTerms)
        .commitment(
            List.of(
                new MasumiCommitmentInput(
                    "body", "jcs", "application/json", Map.of("days", 3, "units", "metric"), true)))
        .payByTime(Long.toString(PAY_BY))
        .submitResultTime(Long.toString(PAY_BY + 5 * 60_000))
        .unlockTime(Long.toString(PAY_BY + 20 * 60_000))
        .externalDisputeUnlockTime(Long.toString(PAY_BY + 35 * 60_000))
        .sellerNonce("ab".repeat(32))
        .unsafeSkipPolicyChecks(true);
  }

  /**
   * Issues a quote.
   *
   * @param customize changes to the base
   * @return the requirements
   */
  public static PaymentRequirements issue(Consumer<MasumiIssue.Builder> customize) {
    MasumiIssue.Builder b = base();
    customize.accept(b);
    return MasumiIssue.issue(b.build());
  }

  /**
   * A deep, mutable copy of the requirements' extra.
   *
   * @param requirements the requirements
   * @return the map
   */
  public static Map<String, Object> mutableExtra(PaymentRequirements requirements) {
    return X402Json.mapper().convertValue(requirements.extra(), new TypeReference<Map<String, Object>>() {});
  }

  /**
   * The validated extra of a quote.
   *
   * @param requirements the requirements
   * @return the extra
   */
  public static MasumiExtra extra(PaymentRequirements requirements) {
    return MasumiSchema.validate(requirements.extra(), requirements.network()).extra();
  }

  /**
   * The lock datum input matching a quote.
   *
   * @param requirements the quote
   * @param collateral the collateral
   * @return the datum input
   */
  public static MasumiDatum.LockInput lockInput(PaymentRequirements requirements, long collateral) {
    MasumiExtra e = extra(requirements);
    return new MasumiDatum.LockInput(
        BUYER,
        e.terms().sellerAddress(),
        null,
        e.terms().sellerReturnAddress(),
        e.referenceKey(),
        e.referenceSignature(),
        e.terms().sellerNonce(),
        e.terms().buyerNonce(),
        e.terms().agentIdentifierOrEmpty(),
        BigInteger.valueOf(collateral),
        e.terms().inputHash(),
        new BigInteger(e.terms().payByTime()),
        new BigInteger(e.terms().submitResultTime()),
        new BigInteger(e.terms().unlockTime()),
        new BigInteger(e.terms().externalDisputeUnlockTime()));
  }

  /**
   * Replaces one field of a 19-field lock datum.
   *
   * @param datum the datum
   * @param index the field index
   * @param value the new value
   * @return the new datum CBOR
   */
  public static byte[] withField(PlutusData datum, int index, PlutusData value) {
    ConstrPlutusData c = (ConstrPlutusData) datum;
    List<PlutusData> fields = new ArrayList<>(PlutusEncoding.fields(c));
    fields.set(index, value);
    return PlutusEncoding.encode(
        ConstrPlutusData.builder().alternative(c.getAlternative()).data(PlutusEncoding.list(fields)).build());
  }

  /**
   * A decoded transaction with one escrow output.
   *
   * @param payTo the escrow address
   * @param datum the inline datum CBOR, or {@code null}
   * @param coin the output lovelace
   * @param assets the output assets
   * @param refScript whether the output carries a reference script
   * @param ttlSlot the TTL, or {@code null}
   * @param vkeyHashes the witness key hashes
   * @return the decoded view
   */
  public static DecodedCardanoTransaction lock(
      String payTo,
      byte[] datum,
      long coin,
      Map<String, BigInteger> assets,
      boolean refScript,
      Long ttlSlot,
      List<String> vkeyHashes) {
    DecodedCardanoTransaction.Output output =
        new DecodedCardanoTransaction.Output(
            payTo,
            BigInteger.valueOf(coin),
            assets,
            datum == null ? null : HexFormat.of().formatHex(datum),
            200,
            refScript);
    return new DecodedCardanoTransaction(
        "00".repeat(32),
        null,
        ttlSlot == null ? null : BigInteger.valueOf(ttlSlot),
        null,
        List.of(TxBuilder.hash32(0xaa) + "#0"),
        BigInteger.valueOf(200_000),
        400,
        List.of(),
        List.of(output),
        1,
        vkeyHashes,
        0,
        0,
        true,
        true);
  }

  /**
   * A TTL slot well before {@link #PAY_BY} on preprod.
   *
   * @return the slot
   */
  public static long ttlBeforePayBy() {
    return 86_400L + (PAY_BY - 1_655_769_600_000L) / 1000 - 60;
  }
}
