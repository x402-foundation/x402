package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * The datum a script payment locks, by policy. {@code reference} refuses only what can never be
 * spent (a Plutus V1 script with an inline datum); {@code strict} needs the datum kind each Plutus
 * version can spend, and some datum when the version is unknown; {@code v3-optional} also lets a
 * Plutus V3 output carry none.
 */
class ScriptDatumPolicyTest {

  private static final String CODE = "4d01000033222220051200120011";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = HASH + "#0";
  private static final byte[] INLINE = {(byte) 0xd8, 0x79, (byte) 0x80};
  private static final byte[] DATUM_HASH = new byte[32];

  private enum Datum { NONE, INLINE, HASH }

  private final StubBackend backend = new StubBackend();

  private static Map<String, Object> extra(String type) {
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethod", "script");
    if (type == null) {
      extra.put("scriptHash", "ab".repeat(28));
    } else {
      extra.put("script", Map.of("type", type, "code", CODE));
    }
    return extra;
  }

  private VerifyResponse verify(ScriptDatumPolicy policy, String type, Datum datum) {
    Map<String, Object> extra = extra(type);
    String payTo = CardanoAddresses.enterpriseScriptAddress("cardano:preprod", ScriptAddresses.deriveScriptHashHex(extra));
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    TxBuilder b = TxBuilder.create().input(HASH, 0);
    switch (datum) {
      case NONE -> b.output(payTo, 2_000_000, Map.of(), null, false);
      case INLINE -> b.output(payTo, 2_000_000, Map.of(), INLINE, false);
      default -> b.legacyOutput(payTo, 2_000_000, DATUM_HASH);
    }
    String tx = b.output(PAYER, 7_800_000, Map.of(), null, false).fee(200_000).ttl(backend.slot + 300)
        .isValid(true).signWith(TxBuilder.WALLET).build();
    PaymentRequirements req = new PaymentRequirements("exact", "cardano:preprod", "lovelace", "2000000", payTo, 600,
        extra);
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    var options = ExactCardanoFacilitatorOptions.builder();
    if (policy != null) {
      options.scriptDatumPolicy(policy);
    }
    return new ExactCardanoFacilitatorScheme(backend, null, options.build())
        .verify(new PaymentPayload(2, null, req, p, null), req, FacilitatorContext.EMPTY);
  }

  private void accepted(ScriptDatumPolicy policy, String type, Datum datum) {
    VerifyResponse verdict = verify(policy, type, datum);
    assertThat(verdict.isValid()).as(policy + " " + type + " " + datum + ": " + verdict.invalidReason()).isTrue();
  }

  private void refused(ScriptDatumPolicy policy, String type, Datum datum) {
    assertThat(verify(policy, type, datum).invalidReason()).as(policy + " " + type + " " + datum)
        .isEqualTo(CardanoErrors.SCRIPT_DATUM_MISSING);
  }

  @Test
  void referenceIsTheDefaultAndRefusesOnlyAnInlineDatumForPlutusV1() {
    refused(null, "plutusV1", Datum.INLINE);
    accepted(null, "plutusV1", Datum.HASH);
    accepted(null, "plutusV2", Datum.NONE);
    accepted(null, null, Datum.NONE);
    refused(ScriptDatumPolicy.REFERENCE, "plutusV1", Datum.INLINE);
  }

  @Test
  void strictNeedsTheDatumKindEachVersionCanSpend() {
    refused(ScriptDatumPolicy.STRICT, "plutusV1", Datum.INLINE);
    refused(ScriptDatumPolicy.STRICT, "plutusV1", Datum.NONE);
    accepted(ScriptDatumPolicy.STRICT, "plutusV1", Datum.HASH);
    refused(ScriptDatumPolicy.STRICT, "plutusV2", Datum.NONE);
    accepted(ScriptDatumPolicy.STRICT, "plutusV2", Datum.INLINE);
    accepted(ScriptDatumPolicy.STRICT, "plutusV2", Datum.HASH);
    refused(ScriptDatumPolicy.STRICT, "plutusV3", Datum.NONE);
    accepted(ScriptDatumPolicy.STRICT, "plutusV3", Datum.INLINE);
    refused(ScriptDatumPolicy.STRICT, null, Datum.NONE);
    accepted(ScriptDatumPolicy.STRICT, null, Datum.HASH);
  }

  @Test
  void v3OptionalLetsOnlyPlutusV3GoWithoutADatum() {
    accepted(ScriptDatumPolicy.V3_OPTIONAL, "plutusV3", Datum.NONE);
    refused(ScriptDatumPolicy.V3_OPTIONAL, "plutusV2", Datum.NONE);
    refused(ScriptDatumPolicy.V3_OPTIONAL, null, Datum.NONE);
  }
}
