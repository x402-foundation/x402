package org.x402.mechanisms.cardano.exact.masumi;

import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * COSE, datum, identifier, LZ and issuance edge cases.
 */
class MasumiPrimitivesTest {

  private static final String ADDRESS = TxBuilder.walletAddress();
  private static final byte[] DIGEST = HexFormat.of().parseHex("22".repeat(32));
  private static final HexFormat HEX = HexFormat.of();

  private static String key(Cbor.Writer w) {
    return HEX.formatHex(w.toByteArray());
  }

  private static Cbor.Writer goodKey() {
    return new Cbor.Writer()
        .header(5, 4)
        .header(0, 1).header(0, 1)
        .header(0, 3).integer(-8)
        .integer(-1).header(0, 6)
        .integer(-2).bytes(TxBuilder.WALLET.publicKeyBytes());
  }

  /** Signs an arbitrary protected header the way a verifier re-encodes it. */
  private static String sign1(byte[] protectedBytes, byte[] unprotected, byte[] payload) {
    byte[] sig =
        new EdDSASigningProvider()
            .signExtended(
                new Cbor.Writer().header(4, 4).text("Signature1").bytes(protectedBytes).bytes(new byte[0]).bytes(payload).toByteArray(),
                TxBuilder.WALLET.privateKeyBytes(),
                TxBuilder.WALLET.publicKeyBytes());
    return HEX.formatHex(
        new Cbor.Writer().header(4, 4).bytes(protectedBytes).raw(unprotected).bytes(payload).bytes(sig).toByteArray());
  }

  private static byte[] hashedFalse() {
    return new Cbor.Writer().header(5, 1).text("hashed").raw(0xf4).toByteArray();
  }

  private static byte[] protectedHeader() {
    return new Cbor.Writer().header(5, 2).header(0, 1).integer(-8).text("address").bytes(CardanoAddresses.toBytes(ADDRESS)).toByteArray();
  }

  private static boolean verify(String keyHex, String sigHex) {
    return MasumiCose.verifySellerTermsSignature(keyHex, sigHex, ADDRESS, HEX.formatHex(DIGEST));
  }

  @Test
  void coseKeyRules() {
    MasumiSellerAuthorization auth =
        MasumiCose.signData(ADDRESS, DIGEST, TxBuilder.WALLET.privateKeyBytes(), TxBuilder.WALLET.publicKeyBytes());
    assertThat(verify(auth.key(), auth.signature())).isTrue();
    assertThat(verify("01", auth.signature())).isFalse();
    assertThat(verify(key(new Cbor.Writer().header(5, 1).header(0, 1).header(0, 2)), auth.signature())).isFalse();
    String noX = key(new Cbor.Writer().header(5, 3).header(0, 1).header(0, 1).header(0, 3).integer(-8).integer(-1).header(0, 6));
    assertThat(verify(noX, auth.signature())).isFalse();
    String withD = key(goodKey().raw(new byte[0])).replaceFirst("^a4", "a5") + HEX.formatHex(new Cbor.Writer().integer(-4).bytes(new byte[32]).toByteArray());
    assertThat(verify(withD, auth.signature())).isFalse();
    String shortX =
        key(new Cbor.Writer().header(5, 4).header(0, 1).header(0, 1).header(0, 3).integer(-8).integer(-1).header(0, 6).integer(-2).bytes(new byte[31]));
    assertThat(verify(shortX, auth.signature())).isFalse();
    String kid = key(new Cbor.Writer().header(5, 5).header(0, 1).header(0, 1).header(0, 2).bytes(new byte[] {9})
        .header(0, 3).integer(-8).integer(-1).header(0, 6).integer(-2).bytes(TxBuilder.WALLET.publicKeyBytes()));
    assertThat(verify(kid, auth.signature())).isTrue();
    byte[] protectedWithKid = new Cbor.Writer().header(5, 3).header(0, 1).integer(-8).header(0, 4).bytes(new byte[] {8})
        .text("address").bytes(CardanoAddresses.toBytes(ADDRESS)).toByteArray();
    assertThat(verify(kid, sign1(protectedWithKid, hashedFalse(), DIGEST))).isFalse();
  }

  @Test
  void coseSign1Rules() {
    String key = key(goodKey());
    assertThat(verify(key, sign1(protectedHeader(), hashedFalse(), DIGEST))).isTrue();
    assertThat(verify(key, "80")).isFalse();
    assertThat(verify(key, HEX.formatHex(new Cbor.Writer().header(4, 4).header(0, 1).header(5, 0).bytes(DIGEST).bytes(new byte[64]).toByteArray()))).isFalse();
    assertThat(verify(key, sign1(protectedHeader(), new Cbor.Writer().header(5, 0).toByteArray(), DIGEST))).isFalse();
    assertThat(verify(key, sign1(protectedHeader(), new Cbor.Writer().header(5, 1).text("hashed").raw(0xf5).toByteArray(), DIGEST))).isFalse();
    assertThat(verify(key, sign1(protectedHeader(), hashedFalse(), new byte[32]))).isFalse();
    byte[] badLabel = new Cbor.Writer().header(5, 1).bytes(new byte[] {1}).header(0, 1).toByteArray();
    assertThat(verify(key, sign1(badLabel, hashedFalse(), DIGEST))).isFalse();
    assertThat(verify(key, sign1(new Cbor.Writer().header(4, 0).toByteArray(), hashedFalse(), DIGEST))).isFalse();
    byte[] noAddress = new Cbor.Writer().header(5, 1).header(0, 1).integer(-8).toByteArray();
    assertThat(verify(key, sign1(noAddress, hashedFalse(), DIGEST))).isFalse();
    byte[] wrongAlg = new Cbor.Writer().header(5, 2).header(0, 1).integer(-7).text("address").bytes(CardanoAddresses.toBytes(ADDRESS)).toByteArray();
    assertThat(verify(key, sign1(wrongAlg, hashedFalse(), DIGEST))).isFalse();
    byte[] otherAddress = new Cbor.Writer().header(5, 2).header(0, 1).integer(-8).text("address")
        .bytes(CardanoAddresses.toBytes(MasumiFixtures.SELLER.sellerAddress())).toByteArray();
    assertThat(verify(key, sign1(otherAddress, hashedFalse(), DIGEST))).isFalse();
    // Extra headers of every CBOR kind are re-encoded definitely before verifying.
    byte[] rich = new Cbor.Writer().header(5, 6).header(0, 1).integer(-8).text("address").bytes(CardanoAddresses.toBytes(ADDRESS))
        .text("list").header(4, 2).header(0, 1).text("x")
        .text("map").header(5, 1).text("k").raw(0xf6)
        .text("tag").header(6, 24).bytes(new byte[] {1})
        .text("neg").integer(-100).toByteArray();
    assertThat(verify(key, sign1(rich, hashedFalse(), DIGEST))).isTrue();
    byte[] withFloat = new Cbor.Writer().header(5, 3).header(0, 1).integer(-8).text("address").bytes(CardanoAddresses.toBytes(ADDRESS))
        .text("f").raw(new byte[] {(byte) 0xf9, 0x3c, 0x00}).toByteArray();
    assertThat(verify(key, sign1(withFloat, hashedFalse(), DIGEST))).isFalse();
    String script = CardanoAddresses.enterpriseScriptAddress("cardano:preprod", TxBuilder.hash28(1));
    assertThat(MasumiCose.verifySellerTermsSignature(key, sign1(protectedHeader(), hashedFalse(), DIGEST), script, HEX.formatHex(DIGEST)))
        .isFalse();
    String otherKey = key(new Cbor.Writer().header(5, 4).header(0, 1).header(0, 1).header(0, 3).integer(-8).integer(-1).header(0, 6)
        .integer(-2).bytes(new byte[32]));
    assertThat(verify(otherKey, sign1(protectedHeader(), hashedFalse(), DIGEST))).isFalse();
  }

  @Test
  void datumParsingAndCredentials() {
    PlutusData datum = MasumiDatum.build(MasumiFixtures.lockInput(MasumiFixtures.issue(b -> {}), 0));
    assertThat(MasumiDatum.parse(PlutusEncoding.encode(datum))).isNotNull();
    for (int i = 0; i < 19; i++) {
      assertThat(MasumiDatum.parse(MasumiFixtures.withField(datum, i, new ListPlutusData())))
          .as("field " + i).isNull();
    }
    assertThat(MasumiDatum.parse(MasumiFixtures.withField(datum, 18, PlutusEncoding.constr(0, BigIntPlutusData.of(1))))).isNull();
    assertThat(MasumiDatum.parse(PlutusEncoding.encode(PlutusEncoding.constr(1)))).isNull();

    PlutusData address = PlutusEncoding.fields(datum).get(0);
    PlutusData shortHash = PlutusEncoding.constr(0, PlutusEncoding.constr(0, PlutusEncoding.bytes("00")), PlutusEncoding.constr(1));
    PlutusData badCred = PlutusEncoding.constr(0, PlutusEncoding.constr(2, PlutusEncoding.bytes(TxBuilder.hash28(1))), PlutusEncoding.constr(1));
    PlutusData badOpt = PlutusEncoding.constr(0, PlutusEncoding.fields(address).get(0), PlutusEncoding.constr(1, BigIntPlutusData.of(1)));
    PlutusData badRef = PlutusEncoding.constr(0, PlutusEncoding.fields(address).get(0), PlutusEncoding.constr(0, PlutusEncoding.constr(2)));
    PlutusData negPointer = PlutusEncoding.constr(0, PlutusEncoding.fields(address).get(0),
        PlutusEncoding.constr(0, PlutusEncoding.constr(1, BigIntPlutusData.of(-1), BigIntPlutusData.of(0), BigIntPlutusData.of(0))));
    for (PlutusData bad : List.of(shortHash, badCred, badOpt, badRef, negPointer, BigIntPlutusData.of(1))) {
      assertThat(MasumiDatum.parse(MasumiFixtures.withField(datum, 0, bad))).isNull();
      assertThat(MasumiDatum.parse(MasumiFixtures.withField(datum, 1, PlutusEncoding.constr(0, bad)))).isNull();
    }
    assertThat(MasumiDatum.parse(MasumiFixtures.withField(datum, 1, PlutusEncoding.constr(2)))).isNull();

    // Pointer and base addresses round-trip through the datum.
    byte[] pointerBytes = new byte[33];
    pointerBytes[0] = 0x40;
    System.arraycopy(HEX.parseHex(TxBuilder.hash28(3)), 0, pointerBytes, 1, 28);
    pointerBytes[29] = (byte) 0x81;
    pointerBytes[30] = 0x01;
    pointerBytes[31] = 0x02;
    pointerBytes[32] = 0x03;
    String pointer = CardanoAddresses.toBech32(pointerBytes);
    var creds = MasumiDatum.addressCredentials(pointer);
    assertThat(creds.pointer().slot()).isEqualTo(BigInteger.valueOf(129));
    assertThat(MasumiDatum.sameCredentials(creds, creds)).isTrue();
    assertThat(MasumiDatum.sameCredentials(creds, MasumiDatum.addressCredentials(ADDRESS))).isFalse();
    var input = MasumiFixtures.lockInput(MasumiFixtures.issue(b -> {}), 0);
    var withPointer = new MasumiDatum.LockInput(pointer, input.sellerAddress(), ADDRESS, input.sellerAddress(), input.referenceKey(),
        input.referenceSignature(), input.sellerNonce(), input.buyerNonce(), input.agentIdentifier(), BigInteger.ZERO,
        input.inputHash(), input.payByTime(), input.submitResultTime(), input.unlockTime(), input.externalDisputeUnlockTime());
    MasumiDatum.View view = MasumiDatum.parse(PlutusEncoding.encode(MasumiDatum.build(withPointer)));
    assertThat(view.buyer().pointer()).isNotNull();
    assertThat(view.buyerReturnAddress()).isNotNull();
    assertThat(view.sellerReturnAddress()).isNotNull();
  }

  @Test
  void identifierAndLz() {
    for (String text : List.of("a", "abababababab", "ünïcödé ✓ 😀 x".repeat(20), "x".repeat(3000))) {
      byte[] packed = LzString.compressToUint8Array(text);
      assertThat(LzString.decompressBounded(packed, 100_000)).isEqualTo(text);
    }
    assertThat(LzString.decompressBounded(new byte[] {1}, 10)).isNull();
    assertThat(LzString.decompressBounded(new byte[] {0, 0}, 10)).isNull();
    assertThat(LzString.decompressBounded(LzString.compressToUint8Array("abcdef"), 2)).isNull();
    assertThat(LzString.decompressBounded(new byte[] {0x40, 0}, 10)).isEqualTo("");
    assertThat(LzString.decompressBounded(new byte[] {(byte) 0xff, (byte) 0xff}, 10)).isNull();
    assertThat(MasumiIdentifier.decode(HEX.formatHex(LzString.compressToUint8Array("a.b")))).isNull();
    assertThat(MasumiIdentifier.decode(HEX.formatHex(LzString.compressToUint8Array("short.b.c.d.e")))).isNull();
    var parts = new MasumiIdentifier.Parts("ab".repeat(32), "", "", "x".repeat(40_000), "k", "c");
    assertThatThrownBy(() -> MasumiIdentifier.encode(parts)).hasMessage("Masumi identifier text exceeds the character limit");
  }

  @Test
  void issuancePolicy() {
    Clock clock = Clock.fixed(Instant.ofEpochMilli(MasumiFixtures.PAY_BY - 300_000), ZoneOffset.UTC);
    MasumiIssue.Builder ok =
        MasumiFixtures.base()
            .unsafeSkipPolicyChecks(false)
            .clock(clock)
            .submitResultTime(Long.toString(MasumiFixtures.PAY_BY + 15 * 60_000))
            .unlockTime(Long.toString(MasumiFixtures.PAY_BY + 30 * 60_000))
            .externalDisputeUnlockTime(Long.toString(MasumiFixtures.PAY_BY + 45 * 60_000));
    assertThat(MasumiIssue.issue(ok.build()).payTo()).startsWith("addr_test1w");
    assertThatThrownBy(() -> MasumiIssue.issue(ok.amount("0").build())).hasMessage("Masumi amount must be a positive canonical integer: 0");
    ok.amount("1");
    assertThatThrownBy(() -> MasumiIssue.issue(ok.asset("ADA").build())).hasMessage("Masumi asset must use canonical lowercase form: ADA");
    ok.asset("lovelace");
    assertThatThrownBy(() -> MasumiIssue.issue(ok.maxTimeoutSeconds(0).build()))
        .hasMessage("Masumi maxTimeoutSeconds must be a positive safe integer");
    ok.maxTimeoutSeconds(600);
    assertThatThrownBy(() -> MasumiIssue.issue(ok.payByTime("x").build()))
        .hasMessage("Masumi payByTime must be a positive POSIX-ms integer string");
    ok.payByTime(Long.toString(MasumiFixtures.PAY_BY));
    assertThatThrownBy(() -> MasumiIssue.issue(MasumiFixtures.base().unsafeSkipPolicyChecks(false).clock(clock).build()))
        .hasMessage("Masumi submitResultTime must be at least 15 minutes away");
    assertThatThrownBy(() -> MasumiIssue.issue(ok.unlockTime(Long.toString(MasumiFixtures.PAY_BY + 16 * 60_000)).build()))
        .hasMessage("Masumi deadline intervals are below the minimum");
    ok.unlockTime(Long.toString(MasumiFixtures.PAY_BY + 30 * 60_000));
    Clock late = Clock.fixed(Instant.ofEpochMilli(MasumiFixtures.PAY_BY), ZoneOffset.UTC);
    assertThatThrownBy(() -> MasumiIssue.issue(ok.clock(late).build())).hasMessage("Masumi payByTime must be in the future");
    Clock early = Clock.fixed(Instant.ofEpochMilli(MasumiFixtures.PAY_BY - 3_600_000), ZoneOffset.UTC);
    assertThatThrownBy(() -> MasumiIssue.issue(ok.clock(early).build())).hasMessage("Masumi payByTime exceeds maxTimeoutSeconds");
    assertThatThrownBy(() -> MasumiIssue.issue(ok.clock(clock).maxDeadlineHorizonMs(BigInteger.ONE).build()))
        .hasMessage("Masumi deadlines extend beyond the accepted horizon");
    assertThatThrownBy(() -> MasumiIssue.issue(MasumiFixtures.base().network("cardano:preview").build()))
        .hasMessage("Network cardano:preview has no canonical Masumi deployment; supply extra.deployment");
    assertThatThrownBy(() -> MasumiIssue.issue(MasumiFixtures.base().buyerNonce("01").build()))
        .hasMessage("Issued Masumi requirements are invalid: terms.buyerNonce must be empty or 14-26 lowercase hex chars");
    assertThat(MasumiIssue.issue(MasumiFixtures.base().sellerNonce(null).build()).extra()).containsKey("terms");
  }

  @Test
  void collateralAndMinUtxoRules() {
    BigInteger cpub = BigInteger.valueOf(4310);
    assertThat(MasumiConstants.collateralLovelace(BigInteger.valueOf(100_000_000), 500, 0, cpub)).isZero();
    assertThat(MasumiConstants.collateralLovelace(BigInteger.ZERO, 500, 1, cpub)).isEqualTo(MasumiConstants.minUtxoLovelace(500, 1, cpub));
    assertThat(MasumiConstants.collateralLovelace(BigInteger.valueOf(3_000_000), 500, 0, cpub))
        .isEqualTo(MasumiConstants.MIN_COLLATERAL_LOVELACE);
    assertThat(MasumiBlueprint.compiledCode()).startsWith("5926a1");
    assertThat(new MasumiTermsRecord("d", null, null).withClaimedTxHash("t").claimedTxHash()).isEqualTo("t");
    assertThat(MasumiDeployment.fromJson(MasumiDeployment.DEFAULT.toJson())).isEqualTo(MasumiDeployment.DEFAULT);
    assertThat(Map.of()).isEmpty();
  }
}
