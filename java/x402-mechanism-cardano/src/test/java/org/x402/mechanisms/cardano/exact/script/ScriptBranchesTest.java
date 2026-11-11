package org.x402.mechanisms.cardano.exact.script;

import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigInteger;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;

/**
 * Script-hash derivation errors, script datum parsing and malformed flat
 * programs.
 */
class ScriptBranchesTest {

  private static final String CODE = "4d01000033222220051200120011";

  private static Map<String, Object> script(Object parameters) {
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("script", Map.of("type", "plutusV3", "code", CODE));
    if (parameters != null) {
      extra.put("parameters", parameters);
    }
    return extra;
  }

  private static Map<String, Object> param(String type, Object value) {
    Map<String, Object> p = new HashMap<>();
    p.put("type", type);
    p.put("value", value);
    return p;
  }

  private static String error(Object parameters) {
    try {
      ScriptAddresses.deriveScriptHashHex(script(parameters));
      return null;
    } catch (IllegalArgumentException e) {
      return e.getMessage();
    }
  }

  @Test
  void parameterErrorsMatchTypeScript() {
    assertThat(error(Map.of("a", 5))).isEqualTo("Cardano script parameter must be an object");
    assertThat(error(Map.of("a", List.of()))).isEqualTo("Unsupported Cardano script parameter type: undefined");
    assertThat(error(Map.of("a", param(null, 1)))).isEqualTo("Unsupported Cardano script parameter type: null");
    assertThat(error(Map.of("a", param("constr", 1)))).isEqualTo("Unsupported Cardano script parameter type: constr");
    assertThat(error(Map.of("a", param("bytes", "ABC")))).isEqualTo("Cardano bytes parameter must be lowercase even-length hex");
    assertThat(error(Map.of("a", param("string", 3)))).isEqualTo("Cardano string parameter must carry a string");
    assertThat(error(Map.of("a", param("integer", 1.5)))).isEqualTo("Cardano integer parameter must be a safe integer");
    assertThat(error(Map.of("a", param("integer", 9_007_199_254_740_992L)))).isEqualTo("Cardano integer parameter must be a safe integer");
    assertThat(error(Map.of("a", param("integer", "01")))).isEqualTo("Cardano integer parameter must use canonical decimal syntax");
    assertThat(error(Map.of("a", param("bigint", "1".repeat(129))))).isEqualTo("Cardano integer parameter exceeds the digit limit");
    assertThat(error(Map.of("a", param("boolean", "yes")))).isEqualTo("Cardano boolean parameter must carry a boolean");
    Map<String, Object> many = new LinkedHashMap<>();
    for (int i = 0; i < 65; i++) {
      many.put("p" + i, param("boolean", true));
    }
    assertThat(error(many)).isEqualTo("Cardano script has too many parameters");
    assertThat(error(Map.of("a", param("bytes", "ab".repeat(70_000))))).isEqualTo("Cardano script parameters exceed the byte limit");
    assertThat(error(List.of(param("integer", 2.0), param("bigint", BigInteger.TEN)))).isNull();
    assertThat(error("xy")).isEqualTo("Cardano script parameter must be an object");
    assertThat(error(Map.of("4294967295", param("boolean", false), "0", param("boolean", true)))).isNull();
  }

  @Test
  void scriptHashAndCodeRules() {
    assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(Map.of("script", Map.of("type", "plutusV3", "code", "abc"))))
        .hasMessage("Cardano script code is invalid or exceeds the byte limit");
    assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(Map.of("script", Map.of("type", "plutusV3", "code", 12))))
        .hasMessage("Cardano script code is invalid or exceeds the byte limit");
    assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(Map.of("script", Map.of("type", "native", "code", CODE))))
        .hasMessage("Unsupported Cardano script type: native");
    assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(Map.of("scriptHash", "AB".repeat(28))))
        .hasMessage("Cardano scriptHash must be 28-byte lowercase hex");
    assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(Map.of("scriptHash", "", "script", Map.of("code", false))))
        .hasMessage("Cardano script payment requires either `script` or `scriptHash`");
    assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(Map.of("scriptHash", 0)))
        .hasMessage("Cardano script payment requires either `script` or `scriptHash`");
    String hash = ScriptAddresses.deriveScriptHashHex(Map.of("scriptHash", "ab".repeat(28)));
    String address = CardanoAddresses.enterpriseScriptAddress("cardano:preprod", hash);
    assertThat(ScriptAddresses.scriptAddressMatches(Map.of("scriptHash", "ab".repeat(28)), address)).isTrue();
    assertThat(ScriptAddresses.scriptAddressMatches(Map.of("scriptHash", "XX"), address)).isFalse();
    assertThat(ScriptAddresses.scriptAddressMatches(Map.of("scriptHash", "ab".repeat(28)), "garbage")).isFalse();
  }

  @Test
  void flatProgramsMustBeWellFormed() {
    assertThatThrownBy(() -> FlatApplier.applyParams(new byte[] {0x01}, List.of())).hasMessage("malformed flat UPLC program");
    // version 1.0.0 then an unknown term tag (15).
    assertThatThrownBy(() -> FlatApplier.applyParams(new byte[] {1, 0, 0, (byte) 0xf0}, List.of()))
        .hasMessage("malformed flat UPLC program");
    // A CBOR-looking prefix that is not valid CBOR is treated as raw flat.
    assertThatThrownBy(() -> FlatApplier.applyParams(new byte[] {0x5f}, List.of(BigIntPlutusData.of(1))))
        .hasMessage("malformed flat UPLC program");
  }

  @Test
  void scriptDatumParsing() {
    assertThat(ScriptDatum.datumBytes(null)).isNull();
    assertThat(ScriptDatum.datumBytes(Map.of())).isNull();
    assertThat(ScriptDatum.datumBytes(Map.of("datum", "d87980"))).containsExactly(0xd8, 0x79, 0x80);
    for (Object bad : List.of("", "abc", 5)) {
      assertThatThrownBy(() -> ScriptDatum.datumBytes(Map.of("datum", bad)))
          .hasMessage("Cardano script payment \"datum\" must be non-empty CBOR hex");
    }
    assertThatThrownBy(() -> ScriptDatum.datumBytes(Map.of("datum", "zz")))
        .hasMessage("Cardano script payment \"datum\" is not valid CBOR hex");
  }
}
