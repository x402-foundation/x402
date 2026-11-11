package org.x402.mechanisms.cardano.exact.client;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.testing.Ccl;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoUtils;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/**
 * What the client's transaction encoding must keep doing. A facilitator that decodes and
 * re-encodes canonically (the TypeScript one does) must reproduce these bytes, or the transaction
 * id changes and the witness stops verifying. cardano-client-lib 0.7.2 fails cases 1 to 3 when it
 * encodes the transaction itself: it writes inputs in list order, sorts asset names as signed
 * bytes and re-encodes datums.
 */
class ClientTxEncodingRegressionTest {

  private static final HexFormat HEX = HexFormat.of();
  private static final EdDSASigningProvider ED25519 = new EdDSASigningProvider();
  private static final String WALLET = TxBuilder.walletAddress();
  private static final String PAY_TO = CardanoClientAcceptanceTest.PAY_TO;
  private static final ProtocolParams PARAMS = Ccl.PARAMS;
  private static final BigInteger MIN_FEE_A = BigInteger.valueOf(44);
  private static final BigInteger MIN_FEE_B = BigInteger.valueOf(155_381);
  private static final PaymentTransactionBuilder.BodySigner SIGNER = hash -> new byte[][] {
      TxBuilder.WALLET.publicKeyBytes(),
      ED25519.signExtended(hash, TxBuilder.WALLET.privateKeyBytes(), TxBuilder.WALLET.publicKeyBytes())};

  private static Utxo utxo(int b, long coin, Map<String, BigInteger> assets) {
    return Ccl.utxo(TxBuilder.hash32(b), 0, WALLET, BigInteger.valueOf(coin), assets, false);
  }

  private static PaymentTransactionBuilder.Built build(List<Utxo> utxos,
      PaymentTransactionBuilder.Output payment, boolean raise) {
    return PaymentTransactionBuilder.build(new PaymentTransactionBuilder.Spec(utxos, WALLET,
        new PaymentTransactionBuilder.Payment(payment, raise), BigInteger.valueOf(1000), PARAMS),
        SIGNER);
  }

  private static PaymentTransactionBuilder.Output lovelace(long coin) {
    return new PaymentTransactionBuilder.Output(PAY_TO, BigInteger.valueOf(coin), Map.of(), null);
  }

  // ---- 1. Inputs ------------------------------------------------------------------------------

  @Test
  void inputsAreSortedEvenWhenTheNonceSortsAfterAnotherInput() {
    // The nonce (hash 0x09..) is too small alone; the second input (hash 0x02..) sorts before it.
    List<Utxo> utxos = List.of(utxo(9, 1_200_000, Map.of()), utxo(2, 30_000_000, Map.of()));
    PaymentTransactionBuilder.Built built = build(utxos, lovelace(2_000_000), false);

    assertThat(built.inputs()).containsExactly(TxBuilder.hash32(9) + "#0", TxBuilder.hash32(2) + "#0");
    List<String> bodyInputs = new ArrayList<>();
    for (Cbor.Item in : body(built).get(0).untagSet().items()) {
      bodyInputs.add(HEX.formatHex(in.items().get(0).bytes()) + "#" + in.items().get(1).integer());
    }
    assertThat(bodyInputs).containsExactly(TxBuilder.hash32(2) + "#0", TxBuilder.hash32(9) + "#0");
    assertInvariants(utxos, built, lovelace(2_000_000), false);
  }

  // ---- 2. Asset order -------------------------------------------------------------------------

  @Test
  void changeAssetsAreInUnsignedCanonicalOrder() {
    String low = TxBuilder.hash28(0x01);
    String high = TxBuilder.hash28(0x90);
    // Inserted high first, so an order that merely follows insertion would fail too.
    Map<String, BigInteger> tokens = new LinkedHashMap<>();
    tokens.put(high + ".80aa", BigInteger.ONE);
    tokens.put(low + ".80aa", BigInteger.TWO);
    tokens.put(low + ".01aa", BigInteger.TEN);
    List<Utxo> utxos = List.of(utxo(1, 20_000_000, tokens));
    PaymentTransactionBuilder.Built built = build(utxos, lovelace(2_000_000), false);

    Cbor.Item change = body(built).get(1).items().get(1);
    Cbor.Item multiAsset = value(change).items().get(1);
    List<String> policies = new ArrayList<>();
    multiAsset.entries().forEach(e -> policies.add(HEX.formatHex(e.getKey().bytes())));
    assertThat(policies).containsExactly(low, high);
    List<String> names = new ArrayList<>();
    multiAsset.entries().get(0).getValue().entries().forEach(e -> names.add(HEX.formatHex(e.getKey().bytes())));
    assertThat(names).containsExactly("01aa", "80aa");
    assertInvariants(utxos, built, lovelace(2_000_000), false);
  }

  // ---- 3. Datums ------------------------------------------------------------------------------

  @Test
  void aScriptDatumIsCarriedByteForByte() {
    MapPlutusData unsorted = new MapPlutusData();
    unsorted.put(BigIntPlutusData.of(5), BytesPlutusData.of(new byte[] {1}));
    unsorted.put(BigIntPlutusData.of(1), BytesPlutusData.of(new byte[] {2}));
    PlutusData datum = ConstrPlutusData.of(0, unsorted,
        BigIntPlutusData.of(BigInteger.TWO.pow(70)));
    byte[] bytes = PlutusEncoding.encode(datum);
    assertDatumCarriedVerbatim(bytes);
  }

  @Test
  void aNestedConstructorDatumIsCarriedByteForByte() {
    // The shape of a Masumi lock datum: constructors, long byte strings, integers, lists.
    PlutusData datum = ConstrPlutusData.of(0,
        BytesPlutusData.of(new byte[28]),
        ConstrPlutusData.of(1, BytesPlutusData.of(new byte[100])),
        BigIntPlutusData.of(1_700_000_000_000L),
        ListPlutusData.of(BigIntPlutusData.of(1), BytesPlutusData.of(new byte[70])));
    assertDatumCarriedVerbatim(PlutusEncoding.encode(datum));
  }

  private static void assertDatumCarriedVerbatim(byte[] datum) {
    List<Utxo> utxos = List.of(utxo(1, 20_000_000, Map.of()));
    PaymentTransactionBuilder.Output payment =
        new PaymentTransactionBuilder.Output(PAY_TO, BigInteger.ZERO, Map.of(), datum);
    PaymentTransactionBuilder.Built built = build(utxos, payment, true);

    Cbor.Item out = body(built).get(1).items().get(0);
    assertThat(HEX.formatHex(out.get(2).items().get(1).tagged().bytes())).isEqualTo(HEX.formatHex(datum));
    assertInvariants(utxos, built, payment, true);
  }

  @Test
  void theDatumCaseIsMeaningful() {
    // cardano-client-lib would re-encode the first datum (indefinite map, unsorted keys, big
    // integer): the verbatim test above guards against exactly that.
    MapPlutusData unsorted = new MapPlutusData();
    unsorted.put(BigIntPlutusData.of(5), BytesPlutusData.of(new byte[] {1}));
    unsorted.put(BigIntPlutusData.of(1), BytesPlutusData.of(new byte[] {2}));
    byte[] bytes = PlutusEncoding.encode(ConstrPlutusData.of(0, unsorted,
        BigIntPlutusData.of(BigInteger.TWO.pow(70))));
    assertThat(PlutusEncoding.decode(bytes).serializeToHex()).isNotEqualTo(HEX.formatHex(bytes));
  }

  // ---- 5, 6. Invariants over typical builds ---------------------------------------------------

  @Test
  void tokenPaymentKeepsTheInvariants() {
    String usdm = CardanoClientAcceptanceTest.USDM;
    List<Utxo> utxos = List.of(utxo(1, 1_500_000, Map.of()),
        utxo(3, 3_000_000, Map.of(usdm, BigInteger.valueOf(50_000_000))),
        utxo(4, 20_000_000, Map.of()));
    PaymentTransactionBuilder.Output payment = new PaymentTransactionBuilder.Output(
        PAY_TO, BigInteger.ZERO, Map.of(usdm, BigInteger.valueOf(10_000_000)), null);
    assertInvariants(utxos, build(utxos, payment, true), payment, true);
  }

  @Test
  void aTokenPaymentSpendsTheNonceAndTheTokenUtxoOnly() {
    String usdm = CardanoClientAcceptanceTest.USDM;
    List<Utxo> utxos = List.of(utxo(1, 1_500_000, Map.of()),
        utxo(3, 3_000_000, Map.of(usdm, BigInteger.valueOf(50_000_000))),
        utxo(4, 20_000_000, Map.of()));
    PaymentTransactionBuilder.Output payment = new PaymentTransactionBuilder.Output(
        PAY_TO, BigInteger.ZERO, Map.of(usdm, BigInteger.valueOf(10_000_000)), null);
    assertThat(build(utxos, payment, true).inputs())
        .containsExactlyInAnyOrder(TxBuilder.hash32(1) + "#0", TxBuilder.hash32(3) + "#0");
  }

  @Test
  void aSecondInputIsAddedWhenTheChangeWouldBeBelowMinUtxo() {
    // Nonce 1.0 + A 4.6 covers 5.0 ADA but leaves change below min-UTxO: B is spent too, the
    // leftover is not folded into the fee.
    List<Utxo> utxos = List.of(utxo(1, 1_000_000, Map.of()), utxo(2, 4_600_000, Map.of()),
        utxo(3, 3_000_000, Map.of()));
    PaymentTransactionBuilder.Built built = build(utxos, lovelace(5_000_000), false);
    assertThat(built.inputs()).containsExactlyInAnyOrder(
        TxBuilder.hash32(1) + "#0", TxBuilder.hash32(2) + "#0", TxBuilder.hash32(3) + "#0");
    assertThat(body(built).get(1).items()).hasSize(2);
    assertInvariants(utxos, built, lovelace(5_000_000), false);
  }

  @Test
  void aWalletUtxoWithADatumHashCanFundThePayment() {
    Utxo withDatumHash = Ccl.utxo(TxBuilder.hash32(4), 0, WALLET, BigInteger.valueOf(30_000_000), Map.of(), false);
    withDatumHash.setDataHash("ab".repeat(32));
    List<Utxo> utxos = List.of(utxo(1, 1_000_000, Map.of()), withDatumHash);
    PaymentTransactionBuilder.Built built = build(utxos, lovelace(5_000_000), false);
    assertThat(built.inputs()).containsExactlyInAnyOrder(TxBuilder.hash32(1) + "#0", TxBuilder.hash32(4) + "#0");
    assertInvariants(utxos, built, lovelace(5_000_000), false);
  }

  @Test
  void aReferenceListedTwiceIsSpentOnce() {
    Utxo nonce = utxo(1, 1_000_000, Map.of());
    List<Utxo> utxos = List.of(nonce, utxo(1, 1_000_000, Map.of()), utxo(3, 30_000_000, Map.of()),
        utxo(3, 30_000_000, Map.of()));
    PaymentTransactionBuilder.Built built = build(utxos, lovelace(5_000_000), false);
    assertThat(built.inputs()).doesNotHaveDuplicates();
    assertThat(body(built).get(0).untagSet().items()).hasSize(built.inputs().size());
  }

  @Test
  void feeParametersThatOverflowAreRefused() {
    List<Utxo> utxos = List.of(utxo(1, 50_000_000, Map.of()));
    PaymentTransactionBuilder.Spec spec = new PaymentTransactionBuilder.Spec(utxos, WALLET,
        new PaymentTransactionBuilder.Payment(lovelace(2_000_000), false), BigInteger.valueOf(1000),
        Ccl.params(4310, 20_000_000, 155_381));
    org.assertj.core.api.Assertions.assertThatThrownBy(() -> PaymentTransactionBuilder.build(spec, SIGNER))
        .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("out of range");
  }

  @Test
  void assetNamesAreOrderedShorterFirst() {
    String policy = TxBuilder.hash28(0x01);
    Map<String, BigInteger> tokens = new LinkedHashMap<>();
    tokens.put(policy + ".ffff", BigInteger.ONE);
    tokens.put(policy + ".000000", BigInteger.ONE);
    List<Utxo> utxos = List.of(utxo(1, 20_000_000, tokens));
    PaymentTransactionBuilder.Built built = build(utxos, lovelace(2_000_000), false);

    Cbor.Item multiAsset = value(body(built).get(1).items().get(1)).items().get(1);
    List<String> names = new ArrayList<>();
    multiAsset.entries().get(0).getValue().entries().forEach(e -> names.add(HEX.formatHex(e.getKey().bytes())));
    assertThat(names).containsExactly("ffff", "000000");
  }

  @Test
  void theFoldPathPaysTheLeftoverAsFee() {
    List<Utxo> utxos = List.of(utxo(1, 2_300_000, Map.of()));
    PaymentTransactionBuilder.Built built = build(utxos, lovelace(2_000_000), false);
    assertThat(built.fee()).isEqualTo(BigInteger.valueOf(300_000));
    assertInvariants(utxos, built, lovelace(2_000_000), false);
  }

  @Test
  void theNonceIsAlwaysSpentAndReferenceScriptsNever() {
    Utxo withScript = Ccl.utxo(TxBuilder.hash32(5), 0, WALLET, BigInteger.valueOf(90_000_000), Map.of(), true);
    List<Utxo> utxos = List.of(utxo(1, 1_000_000, Map.of()), withScript, utxo(3, 30_000_000, Map.of()));
    PaymentTransactionBuilder.Built built = build(utxos, lovelace(5_000_000), false);

    assertThat(built.nonce()).isEqualTo(TxBuilder.hash32(1) + "#0");
    assertThat(built.inputs()).contains(TxBuilder.hash32(1) + "#0")
        .doesNotContain(TxBuilder.hash32(5) + "#0");
    assertInvariants(utxos, built, lovelace(5_000_000), false);
  }

  // ---- helpers --------------------------------------------------------------------------------

  private static Cbor.Item body(PaymentTransactionBuilder.Built built) {
    return Cbor.decode(built.bytes()).items().get(0);
  }

  /** An output's value item: legacy array {@code [address, value]} or map {@code {0, 1, 2}}. */
  private static Cbor.Item value(Cbor.Item output) {
    return output.major() == Cbor.Major.ARRAY ? output.items().get(1) : output.get(1);
  }

  private static Cbor.Item address(Cbor.Item output) {
    return output.major() == Cbor.Major.ARRAY ? output.items().get(0) : output.get(0);
  }

  /** Lovelace under "lovelace", tokens under "policy.name". */
  private static Map<String, BigInteger> units(Cbor.Item value) {
    Map<String, BigInteger> units = new TreeMap<>();
    if (value.isInteger()) {
      units.put("lovelace", value.integer());
      return units;
    }
    units.put("lovelace", value.items().get(0).integer());
    value.items().get(1).entries().forEach(policy -> policy.getValue().entries().forEach(name ->
        units.merge(HEX.formatHex(policy.getKey().bytes()) + "." + HEX.formatHex(name.getKey().bytes()),
            name.getValue().integer(), BigInteger::add)));
    return units;
  }

  private static void assertInvariants(List<Utxo> utxos, PaymentTransactionBuilder.Built built,
      PaymentTransactionBuilder.Output payment, boolean raise) {
    Cbor.Item tx = Cbor.decode(built.bytes());
    Cbor.Item body = tx.items().get(0);

    // Only inputs, outputs, fee and TTL.
    List<BigInteger> keys = new ArrayList<>();
    body.entries().forEach(e -> keys.add(e.getKey().integer()));
    assertThat(keys).containsExactly(BigInteger.ZERO, BigInteger.ONE, BigInteger.TWO, BigInteger.valueOf(3));

    // Exactly one vkey witness, and it verifies against the body hash.
    Cbor.Item witnesses = tx.items().get(1).get(0).untagSet();
    assertThat(witnesses.items()).hasSize(1);
    byte[] hash = Blake2bUtil.blake2bHash256(body.raw());
    assertThat(ED25519.verify(witnesses.items().get(0).items().get(1).bytes(), hash,
        witnesses.items().get(0).items().get(0).bytes())).isTrue();

    // The nonce is spent; no reference-script UTxO is.
    assertThat(built.inputs()).contains(CardanoUtils.ref(utxos.get(0)));
    for (Utxo u : utxos) {
      if (u.getReferenceScriptHash() != null) {
        assertThat(built.inputs()).doesNotContain(CardanoUtils.ref(u));
      }
    }

    // Value is conserved per unit.
    Map<String, BigInteger> in = new TreeMap<>();
    for (Utxo u : utxos) {
      if (built.inputs().contains(CardanoUtils.ref(u))) {
        in.merge("lovelace", CardanoUtils.lovelace(u), BigInteger::add);
        CardanoUtils.assets(u).forEach((unit, qty) -> in.merge(unit, qty, BigInteger::add));
      }
    }
    Map<String, BigInteger> out = new TreeMap<>();
    out.put("lovelace", built.fee());
    List<Cbor.Item> outputs = body.get(1).items();
    outputs.forEach(o -> units(value(o)).forEach((unit, qty) -> out.merge(unit, qty, BigInteger::add)));
    assertThat(out).isEqualTo(in);

    // The payment output is exactly what was asked; change (if any) goes to the wallet, no datum.
    assertThat(outputs).hasSizeBetween(1, 2);
    Cbor.Item pay = outputs.get(0);
    assertThat(CardanoAddresses.toBech32(address(pay).bytes())).isEqualTo(payment.address());
    Map<String, BigInteger> paid = units(value(pay));
    BigInteger paidCoin = paid.remove("lovelace");
    assertThat(paid).isEqualTo(new TreeMap<>(payment.assets()));
    if (raise) {
      assertThat(paidCoin).isGreaterThanOrEqualTo(payment.coin());
    } else {
      assertThat(paidCoin).isEqualTo(payment.coin());
    }
    byte[] datum = payment.datum();
    if (datum == null) {
      assertThat(pay.major() == Cbor.Major.ARRAY || pay.get(2) == null).isTrue();
    } else {
      assertThat(pay.get(2).items().get(1).tagged().bytes()).isEqualTo(datum);
    }
    if (outputs.size() == 2) {
      Cbor.Item change = outputs.get(1);
      assertThat(CardanoAddresses.toBech32(address(change).bytes())).isEqualTo(WALLET);
      assertThat(change.major()).isEqualTo(Cbor.Major.ARRAY);
    }

    // The fee covers this transaction's own size, and overpays by at most a few bytes' worth
    // (except when the leftover is folded into the fee, and there is no change output).
    BigInteger minFee = MIN_FEE_A.multiply(BigInteger.valueOf(built.bytes().length)).add(MIN_FEE_B);
    assertThat(built.fee()).isGreaterThanOrEqualTo(minFee);
    if (outputs.size() == 2) {
      assertThat(built.fee()).isLessThanOrEqualTo(minFee.add(MIN_FEE_A.multiply(BigInteger.valueOf(9))));
    }
    assertThat(Arrays.equals(body.raw(), Cbor.decode(built.bytes()).items().get(0).raw())).isTrue();
  }
}
