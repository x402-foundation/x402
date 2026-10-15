package org.x402.mechanisms.cardano;

import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.types.ResourceInfo;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.CardanoPolicies;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.CardanoUtils;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.utils.DefaultAssets;
import org.x402.mechanisms.cardano.utils.Jcs;
import org.x402.mechanisms.cardano.utils.MnemonicAccounts;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/**
 * CBOR, Plutus data, JCS, addresses, policies and the transaction decoder on malformed input.
 */
class CodecBranchesTest {

  private static final HexFormat HEX = HexFormat.of();

  private static Cbor.Item cbor(String hex) {
    return Cbor.decode(HEX.parseHex(hex));
  }

  @Test
  void cborReadsEveryMajorTypeAndRefusesMalformedInput() {
    assertThat(cbor("1b0000000100000000").integer()).isEqualTo(BigInteger.valueOf(4_294_967_296L));
    assertThat(cbor("3903e7").integer()).isEqualTo(BigInteger.valueOf(-1000));
    assertThat(cbor("5f42010243030405ff").bytes()).containsExactly(1, 2, 3, 4, 5);
    assertThat(cbor("7f6161626263ff").text()).isEqualTo("abc");
    assertThat(cbor("9f0102ff").items()).hasSize(2);
    assertThat(cbor("bf6161016162f6ff").get("b").isSimple(22)).isTrue();
    assertThat(cbor("a2016161026162").get(2).text()).isEqualTo("b");
    assertThat(cbor("a2016161026162").get("x")).isNull();
    assertThat(cbor("01").get(1)).isNull();
    assertThat(cbor("01").get("x")).isNull();
    assertThat(cbor("f818").integer()).isEqualTo(BigInteger.valueOf(24));
    assertThat(cbor("fb3ff0000000000000").integer()).isNull();
    assertThat(cbor("d9010280").untagSet().items()).isEmpty();
    assertThat(cbor("01").untagSet().major()).isEqualTo(Cbor.Major.UNSIGNED);
    assertThat(cbor("820102").raw()).containsExactly(0x82, 1, 2);
    for (String bad : List.of("", "1c", "18", "4201", "5f01ff", "7f4100ff", "9f01", "bf01", "a1", "ff", "0101", "62c328", "5f41", "7f")) {
      assertThatThrownBy(() -> cbor(bad)).as(bad).isInstanceOf(IllegalArgumentException.class);
    }
    String deep = "81".repeat(300) + "01";
    assertThatThrownBy(() -> cbor(deep)).hasMessage("CBOR nesting exceeds the decoder budget");
    assertThatThrownBy(() -> cbor("9b0000000100000000")).hasMessage("CBOR length exceeds the input");
    Cbor.Writer w = new Cbor.Writer().header(0, 70_000).header(0, BigInteger.valueOf(5_000_000_000L)).integer(-5).text("é");
    assertThat(HEX.formatHex(w.toByteArray())).isEqualTo("1a000111701b000000012a05f2002462c3a9");
    assertThatThrownBy(() -> new Cbor.Writer().header(0, BigInteger.ONE.negate())).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void plutusDataRoundTripsInTheAikenConvention() {
    PlutusData big = BigIntPlutusData.of(BigInteger.TWO.pow(70));
    PlutusData negBig = BigIntPlutusData.of(BigInteger.TWO.pow(70).negate());
    PlutusData longBytes = BytesPlutusData.of(new byte[100]);
    MapPlutusData map = new MapPlutusData();
    map.put(BigIntPlutusData.of(1), PlutusEncoding.bytes("ab"));
    PlutusData constr7 = PlutusEncoding.constr(7, BigIntPlutusData.of(-3));
    PlutusData constr200 = PlutusEncoding.constr(200);
    PlutusData all = PlutusEncoding.list(
        List.of(big, negBig, longBytes, map, new MapPlutusData(), constr7, constr200, new ListPlutusData()));
    byte[] encoded = PlutusEncoding.encode(all);
    assertThat(PlutusEncoding.decode(encoded)).isEqualTo(all);
    PlutusEncoding.check(encoded);
    assertThat(HEX.formatHex(PlutusEncoding.encode(constr200))).isEqualTo("d8668218c880");
    assertThat(longBytes).isNotEqualTo(big);
    for (String bad : List.of("d9010080", "c201", "d8668101", "d87901", "f6", "6161", "d86682616101")) {
      assertThatThrownBy(() -> PlutusEncoding.decode(HEX.parseHex(bad))).as(bad).isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> PlutusEncoding.check(HEX.parseHex(bad))).as(bad).isInstanceOf(IllegalArgumentException.class);
    }
  }

  @Test
  void jcsHandlesJsonTreesRecordsAndRefusesNonStringKeys() {
    var node = JsonNodeFactory.instance.objectNode();
    node.put("b", 1.5).putNull("a");
    node.putArray("c").add(true).add("x");
    node.set("d", JsonNodeFactory.instance.missingNode());
    assertThat(Jcs.canonicalize(node)).isEqualTo("{\"a\":null,\"b\":1.5,\"c\":[true,\"x\"],\"d\":null}");
    assertThat(Jcs.canonicalize(ResourceInfo.of("u"))).isEqualTo("{\"url\":\"u\"}");
    assertThat(Jcs.canonicalize(List.of(new BigDecimal("0.10"), 7L, (short) 2, Float.valueOf(0.5f)))).isEqualTo("[0.1,7,2,0.5]");
    assertThat(Jcs.canonicalize("\u0001\ud83d\ude00")).isEqualTo("\"\\u0001😀\"");
    assertThatThrownBy(() -> Jcs.canonicalize(Map.of(1, 2))).hasMessage("JCS object keys must be strings");
    assertThatThrownBy(() -> Jcs.canonicalize("\udc00")).hasMessageContaining("unpaired surrogate");
    assertThatThrownBy(() -> Jcs.number(Double.POSITIVE_INFINITY)).hasMessage("JCS cannot serialize the non-finite number Infinity");
    assertThatThrownBy(() -> Jcs.number(Double.NEGATIVE_INFINITY)).hasMessage("JCS cannot serialize the non-finite number -Infinity");
    assertThat(Jcs.deepEqual(Map.of("a", 1), Map.of("a", 1.0))).isTrue();
    assertThat(Jcs.deepEqual(new Object(), "x")).isFalse();
    assertThat(Jcs.deepEqual(null, null)).isTrue();
    assertThat(Jcs.number(-0.0)).isEqualTo("0");
  }

  @Test
  void addressesParseEveryShelleyForm() {
    String base = TxBuilder.walletAddress();
    assertThat(CardanoAddresses.parse(base).isBase()).isTrue();
    assertThat(CardanoAddresses.paymentKeyHash(base)).hasSize(56);
    assertThat(CardanoAddresses.paymentKeyHash("nope")).isNull();
    String script = CardanoAddresses.enterpriseScriptAddress("cardano:mainnet", TxBuilder.hash28(1));
    assertThat(script).startsWith("addr1w");
    assertThat(CardanoAddresses.paymentKeyHash(script)).isNull();
    assertThat(CardanoAddresses.scriptPaymentCredentialHex(base)).isNull();
    assertThat(CardanoAddresses.isKeyCredentialAddressOn(base, "cardano:mainnet")).isFalse();
    assertThat(CardanoAddresses.isKeyCredentialAddressOn(base, "cardano:preprod")).isTrue();
    assertThat(CardanoAddresses.isKeyCredentialAddressOn(5, "cardano:preprod")).isFalse();
    assertThat(CardanoAddresses.isKeyCredentialAddressOn(script, "cardano:mainnet")).isFalse();
    assertThat(CardanoAddresses.isKeyCredentialAddressOn("garbage", "cardano:mainnet")).isFalse();
    byte[] stakeScript = CardanoAddresses.toBytes(base);
    stakeScript[0] = (byte) 0x20;
    assertThat(CardanoAddresses.isKeyCredentialAddressOn(CardanoAddresses.toBech32(stakeScript), "cardano:preprod")).isFalse();
    byte[] reward = CardanoAddresses.toBytes(base).clone();
    reward[0] = (byte) 0xe0;
    assertThatThrownBy(() -> CardanoAddresses.toBech32(java.util.Arrays.copyOf(reward, 29))).hasMessageContaining("no payment credential");
    assertThatThrownBy(() -> CardanoAddresses.parse(new byte[] {0x60})).hasMessage("address too short");
    assertThatThrownBy(() -> CardanoAddresses.parse(java.util.Arrays.copyOf(stakeScript, 40))).hasMessage("base address must be 57 bytes");
    byte[] enterprise = java.util.Arrays.copyOf(CardanoAddresses.toBytes(script), 30);
    assertThatThrownBy(() -> CardanoAddresses.parse(enterprise)).hasMessage("enterprise address must be 29 bytes");
    byte[] pointer = java.util.Arrays.copyOf(CardanoAddresses.toBytes(script), 30);
    pointer[0] = 0x41;
    pointer[29] = (byte) 0x80;
    assertThatThrownBy(() -> CardanoAddresses.parse(pointer)).hasMessage("truncated pointer");
    byte[] longPointer = new byte[29 + 12];
    longPointer[0] = 0x40;
    java.util.Arrays.fill(longPointer, 29, 41, (byte) 0xff);
    assertThatThrownBy(() -> CardanoAddresses.parse(longPointer)).hasMessage("pointer component exceeds 64 bits");
    byte[] trailing = new byte[33];
    trailing[0] = 0x40;
    assertThatThrownBy(() -> CardanoAddresses.parse(trailing)).hasMessage("trailing bytes in pointer address");
    assertThatThrownBy(() -> CardanoAddresses.toBytes("")).hasMessage("address is empty");
    assertThatThrownBy(() -> CardanoAddresses.toBytes("stake1uxyz")).isInstanceOf(IllegalArgumentException.class);
    String stake = com.bloxbean.cardano.client.crypto.Bech32.encode(new byte[] {0x60}, "stake");
    assertThatThrownBy(() -> CardanoAddresses.toBytes(stake)).hasMessageStartingWith("not a Shelley payment address");
    String mixed = com.bloxbean.cardano.client.crypto.Bech32.encode(CardanoAddresses.toBytes(script), "addr_test");
    assertThatThrownBy(() -> CardanoAddresses.toBytes(mixed)).hasMessageStartingWith("address prefix does not match");
  }

  @Test
  void utilsPoliciesNetworksAndAssets() {
    assertThat(CardanoUtils.parseAssetUnit("lovelace").policyId()).isEmpty();
    assertThat(CardanoUtils.parseAssetUnit(TxBuilder.hash28(10).toUpperCase() + ".AB").assetNameHex()).isEqualTo("ab");
    assertThatThrownBy(() -> CardanoUtils.parseAssetUnit("ada")).hasMessage("Invalid Cardano asset unit: ada");
    assertThat(CardanoUtils.parseUtxoRef("AA".repeat(32) + "#007").toString()).isEqualTo("aa".repeat(32) + "#7");
    assertThatThrownBy(() -> CardanoUtils.decodePayload(null)).hasMessage("Cardano payload is missing a transaction string");
    assertThatThrownBy(() -> CardanoUtils.decodePayload(Map.of("transaction", "x".repeat(90_000))))
        .hasMessage("Cardano payload transaction exceeds the decode limit");
    assertThatThrownBy(() -> CardanoUtils.decodePayload(Map.of("transaction", "x", "nonce", "")))
        .hasMessage("Cardano payload is missing a nonce string");

    assertThat(CardanoPolicies.l1Confirmations(null)).isEqualTo(1);
    Map<String, Object> nullPolicy = new LinkedHashMap<>();
    nullPolicy.put("confirmationPolicy", null);
    assertThat(CardanoPolicies.l1Confirmations(nullPolicy)).isNull();
    assertThat(CardanoPolicies.normalize(Map.of("l1Confirmations", BigInteger.TWO))).isEqualTo(2);
    assertThat(CardanoPolicies.normalize(Map.of("l1Confirmations", new BigDecimal("3.0")))).isEqualTo(3);
    assertThat(CardanoPolicies.normalize(Map.of("l1Confirmations", Double.NaN))).isNull();
    assertThat(CardanoPolicies.normalize(Map.of("l1Confirmations", BigInteger.TEN.pow(20)))).isNull();
    assertThat(CardanoPolicies.normalize(Map.of("l1Confirmations", "1"))).isNull();
    assertThat(CardanoPolicies.normalize(Map.of("l1Confirmations", -2))).isNull();
    assertThat(CardanoPolicies.normalize(Map.of("other", 1))).isNull();

    assertThat(CardanoNetworks.normalize(null)).isNull();
    assertThat(CardanoNetworks.isCardanoNetwork(null)).isFalse();
    assertThat(CardanoNetworks.networkId(CardanoNetworks.MAINNET_CIP34)).isEqualTo(1);
    assertThatThrownBy(() -> CardanoNetworks.networkId("solana:x")).hasMessage("Unsupported Cardano network: solana:x");
    assertThatThrownBy(() -> CardanoNetworks.slotConfig(null)).hasMessage("No slot config for network: null");
    assertThat(CardanoNetworks.currentSlot("cardano:preview", Clock.fixed(Instant.ofEpochMilli(1_666_656_010_500L), ZoneOffset.UTC)))
        .isEqualTo(10);

    assertThatThrownBy(() -> DefaultAssets.get("cardano:preprod", "EUR"))
        .hasMessage("No EUR default asset configured for network cardano:preprod");
    assertThat(DefaultAssets.get("cardano:preprod", "usdm").decimals()).isEqualTo(6);
    assertThat(DefaultAssets.find(null, "cardano:preprod")).isNull();
    assertThat(DefaultAssets.find("lovelace", "eip155:1")).isNull();
    assertThat(MnemonicAccounts.normalize("  A  b\tC ")).isEqualTo("a b c");
  }

  @Test
  void theDecoderRefusesMalformedTransactions() {
    String garbage = Base64.getEncoder().encodeToString(HEX.parseHex("820102"));
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode("")).hasMessage("Cardano transaction exceeds the decode limit");
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode("!!!!")).hasMessage("Cardano transaction must use canonical padded base64");
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode("AAE")).hasMessage("Cardano transaction must use canonical padded base64");
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(garbage)).hasMessage("transaction must be a 4-element array");
    for (String hex :
        List.of(
            "8401a0f5f6", "84a0a002f6", "84a0a0f5f6", "84a10001a0f5f6", "84a1008101a0f5f6", "84a20080010ca0f5f6",
            "84a3008001820102020ca0f5f6", "84a300800181820000020ca0f5f6", "84a300800181a20040010ca0f5f6",
            "84a300800181a2004060018201a10101020ca0f5f6", "84a3008001800202a10081820102f5f6",
            "84a300800180020ca1008182582000005840" + "00".repeat(64) + "f5f6")) {
      String b64 = Base64.getEncoder().encodeToString(HEX.parseHex(hex));
      assertThatThrownBy(() -> CardanoTransactionDecoder.decode(b64)).as(hex).isInstanceOf(IllegalArgumentException.class);
    }

    String address = TxBuilder.walletAddress();
    byte[] badDatumOption = new Cbor.Writer().header(5, 3).header(0, 0).bytes(CardanoAddresses.toBytes(address))
        .header(0, 1).header(0, 1).header(0, 2).header(4, 2).header(0, 7).bytes(new byte[1]).toByteArray();
    String tx = TxBuilder.create().input(TxBuilder.hash32(1), 0).rawOutput(badDatumOption).signWith(TxBuilder.WALLET).build();
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).hasMessage("invalid datum option kind");
    byte[] hashOption = new Cbor.Writer().header(5, 3).header(0, 0).bytes(CardanoAddresses.toBytes(address))
        .header(0, 1).header(0, 1).header(0, 2).header(4, 2).header(0, 0).bytes(new byte[32]).toByteArray();
    String withHash = TxBuilder.create().input(TxBuilder.hash32(1), 0).rawOutput(hashOption).signWith(TxBuilder.WALLET)
        .witnessField(2, new Cbor.Writer().header(4, 1).header(4, 0).toByteArray())
        .witnessField(1, new Cbor.Writer().header(4, 0).toByteArray())
        .witnessField(5, new Cbor.Writer().header(4, 1).header(4, 0).toByteArray())
        .build();
    DecodedCardanoTransaction decoded = CardanoTransactionDecoder.decode(withHash);
    assertThat(decoded.outputs().get(0).datum()).isNull();
    assertThat(decoded.vkeyWitnessCount()).isEqualTo(2);
    assertThat(decoded.redeemerCount()).isEqualTo(1);
    byte[] withDatum = new Cbor.Writer().header(5, 3).header(0, 0).bytes(CardanoAddresses.toBytes(address))
        .header(0, 1).header(0, 1).header(0, 2).header(4, 2).header(0, 1).bytes(new byte[1]).toByteArray();
    String inlineNotTagged = TxBuilder.create().input(TxBuilder.hash32(1), 0).rawOutput(withDatum).build();
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(inlineNotTagged)).hasMessage("inline datum must be #6.24(bytes)");
    String redeemerMap = TxBuilder.create().input(TxBuilder.hash32(1), 0).output(address, 1, Map.of(), null, false)
        .witnessField(5, new Cbor.Writer().header(5, 1).header(4, 2).header(0, 0).header(0, 0).header(4, 0).toByteArray())
        .rawWitness(TxBuilder.WALLET.publicKeyBytes(), new byte[64])
        .build();
    DecodedCardanoTransaction mapped = CardanoTransactionDecoder.decode(redeemerMap);
    assertThat(mapped.redeemerCount()).isEqualTo(1);
    assertThat(mapped.signaturesValid()).isFalse();
  }
}
