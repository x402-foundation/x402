package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.json.X402Json;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;
import org.x402.mechanisms.cardano.testing.Vectors;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/**
 * Plutus data encodings and parameterised script hashes, compared with vectors the TypeScript
 * SDK (Evolution) produced: big integers past 64 bits, long byte strings, every constructor tag
 * range, lists, maps and the Masumi lock-datum shapes.
 */
class PlutusEncodingVectorsTest {

  private static final JsonNode V = Vectors.load("plutus-encoding.json");
  private static final HexFormat HEX = HexFormat.of();

  /**
   * Forms where this encoder and Evolution differ; none occurs in a datum or parameter this SDK
   * puts on chain. Here −2^64 is a CBOR negative integer (Evolution: a tag-3 bignum), bignum bytes
   * over 64 are chunked like any Plutus byte string (Evolution: one definite string), and a
   * constructor from index 128 is a definite {@code [index, fields]} pair (Evolution: indefinite).
   * Pinned so a change of encoder shows up here.
   */
  private static final Map<String, String> JAVA_ONLY = Map.of(
      "intNegTwo64", "3bffffffffffffffff",
      "int65ByteMagnitude", "c25f5840" + "ff".repeat(64) + "41ffff",
      "intNeg65ByteMagnitude", "c35f5840" + "ff".repeat(64) + "41ffff",
      "constr128", "d8668218809f02ff",
      "constr2pow40", "d866821b000001000000000080");

  /** Builds the value a vector describes, with cardano-client-lib's builders. */
  static PlutusData build(JsonNode d) {
    if (d.has("int")) {
      return BigIntPlutusData.of(new BigInteger(d.get("int").asText()));
    }
    if (d.has("bytes")) {
      return PlutusEncoding.bytes(d.get("bytes").asText());
    }
    if (d.has("constr")) {
      List<PlutusData> fields = new ArrayList<>();
      d.get("fields").forEach(f -> fields.add(build(f)));
      return PlutusEncoding.constr(Long.parseLong(d.get("constr").asText()), fields.toArray(PlutusData[]::new));
    }
    if (d.has("list")) {
      List<PlutusData> items = new ArrayList<>();
      d.get("list").forEach(i -> items.add(build(i)));
      return PlutusEncoding.list(items);
    }
    MapPlutusData map = new MapPlutusData();
    d.get("map").forEach(e -> map.put(build(e.get(0)), build(e.get(1))));
    return map;
  }

  @Test
  void dataEncodesLikeTypeScript() {
    org.assertj.core.api.SoftAssertions soft = new org.assertj.core.api.SoftAssertions();
    for (JsonNode v : V.get("data")) {
      soft.assertThat(HEX.formatHex(PlutusEncoding.encode(build(v.get("data")))))
          .as(v.get("name").asText())
          .isEqualTo(JAVA_ONLY.getOrDefault(v.get("name").asText(), v.get("cborHex").asText()));
    }
    soft.assertAll();
  }

  @Test
  void parameterisedScriptHashesMatchTypeScript() throws Exception {
    for (JsonNode c : V.get("scriptHashes")) {
      @SuppressWarnings("unchecked")
      Map<String, Object> extra = X402Json.mapper().treeToValue(c.get("extra"), Map.class);
      if (c.has("error")) {
        assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(extra))
            .as(c.get("name").asText())
            .hasMessage(c.get("error").asText());
      } else {
        assertThat(ScriptAddresses.deriveScriptHashHex(extra))
            .as(c.get("name").asText())
            .isEqualTo(c.get("scriptHash").asText());
      }
    }
  }
}
