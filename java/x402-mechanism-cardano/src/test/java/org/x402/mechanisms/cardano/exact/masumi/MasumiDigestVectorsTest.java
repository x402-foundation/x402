package org.x402.mechanisms.cardano.exact.masumi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.Jcs;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;
import org.x402.mechanisms.cardano.exact.server.CardanoSellerSigner;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Masumi digests, JCS, identifiers, escrow derivation, script hashes and deterministic issuance
 * byte-match the TypeScript SDK (vectors exported by {@code java/tools/ts-vectors}).
 */
class MasumiDigestVectorsTest {

  private static final JsonNode V = Vectors.load("masumi-digests.json");

  private static Object json(JsonNode node) {
    try {
      return X402Json.mapper().treeToValue(node, Object.class);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  @Test
  void jcsMatchesTypeScript() {
    for (JsonNode c : V.get("jcs")) {
      assertThat(Jcs.canonicalize(json(c.get("value")))).as(c.get("jcs").asText()).isEqualTo(c.get("jcs").asText());
    }
  }

  @Test
  void jcsRefusesWhatJsonCannotCarry() {
    assertThatThrownBy(() -> Jcs.canonicalize(Map.of("x", Double.NaN)))
        .hasMessageContaining("non-finite");
    assertThatThrownBy(() -> Jcs.canonicalize("\ud800"))
        .hasMessage("JCS cannot serialize a string containing an unpaired surrogate");
    assertThatThrownBy(() -> Jcs.canonicalize(new Object())).hasMessageContaining("cannot serialize");
  }

  @Test
  void commitmentPartDigestsMatchTypeScript() {
    for (JsonNode c : V.get("partDigests")) {
      JsonNode part = c.get("part");
      assertThat(
              MasumiDigests.commitmentPartDigest(
                  part.get("canonicalization").asText(), json(part.get("content"))))
          .as(part.toString())
          .isEqualTo(c.get("digest").asText());
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> commitment = (Map<String, Object>) json(V.get("commitment"));
    assertThat(MasumiDigests.computeInputHash(commitment)).isEqualTo(V.get("commitment").get("digest").asText());
  }

  @Test
  void rawCommitmentContentMustBeCanonicalBase64Url() {
    assertThatThrownBy(() -> MasumiDigests.commitmentPartDigest("raw", "aGVsbG8="))
        .hasMessage("Commitment raw content is not unpadded base64url");
    assertThatThrownBy(() -> MasumiDigests.commitmentPartDigest("raw", "aGVsbG9"))
        .hasMessage("Commitment raw content is not canonical unpadded base64url");
    assertThatThrownBy(() -> MasumiDigests.commitmentPartDigest("raw", 5))
        .hasMessage("Commitment raw content must be an unpadded base64url string");
    assertThatThrownBy(() -> MasumiDigests.commitmentPartBytes("jcs", null, false))
        .hasMessage("Commitment part carries no content to digest");
  }

  @Test
  void termsDigestsSignaturesAndIdentifiersMatchTypeScript() {
    for (JsonNode c : V.get("termsDigests")) {
      PaymentRequirements requirements = Vectors.requirements(c.get("requirements"));
      Map<String, Object> signedTerms = MasumiDigests.buildSignedTerms(requirements);
      assertThat((JsonNode) X402Json.mapper().valueToTree(signedTerms)).isEqualTo(c.get("signedTerms"));
      String digest = MasumiDigests.termsDigest(requirements);
      assertThat(digest).isEqualTo(c.get("termsDigest").asText());

      var schema = MasumiSchema.validate(requirements.extra(), requirements.network());
      assertThat(schema.ok()).isEqualTo(c.get("schemaOk").asBoolean());
      MasumiExtra extra = schema.extra();
      assertThat(
              MasumiCose.verifySellerTermsSignature(
                  extra.referenceKey(), extra.referenceSignature(), extra.terms().sellerAddress(), digest))
          .isEqualTo(c.get("signatureValid").asBoolean());
      assertThat(MasumiCose.verifySellerTermsSignature(extra.referenceKey(), extra.referenceSignature(), extra.terms().sellerAddress(), "00".repeat(32)))
          .isFalse();

      MasumiIdentifier.Parts decoded = MasumiIdentifier.decode(extra.blockchainIdentifier());
      JsonNode expected = c.get("identifier");
      assertThat(decoded.sellerNonce()).isEqualTo(expected.get("sellerNonce").asText());
      assertThat(decoded.agentIdentifier()).isEqualTo(expected.get("agentIdentifier").asText());
      assertThat(decoded.buyerNonce()).isEqualTo(expected.get("buyerNonce").asText());
      assertThat(decoded.referenceSignature()).isEqualTo(expected.get("referenceSignature").asText());
      assertThat(decoded.referenceKey()).isEqualTo(expected.get("referenceKey").asText());
      assertThat(decoded.contractAddress()).isEqualTo(expected.get("contractAddress").asText());
    }
  }

  @Test
  void identifierEncodingMatchesTypeScript() {
    for (JsonNode c : V.get("identifiers")) {
      JsonNode p = c.get("parts");
      var parts =
          new MasumiIdentifier.Parts(
              p.get("sellerNonce").asText(),
              p.get("agentIdentifier").asText(),
              p.get("buyerNonce").asText(),
              p.get("referenceSignature").asText(),
              p.get("referenceKey").asText(),
              p.get("contractAddress").asText());
      assertThat(MasumiIdentifier.buildText(parts)).isEqualTo(c.get("text").asText());
      assertThat(MasumiIdentifier.encode(parts)).isEqualTo(c.get("encoded").asText());
      assertThat(MasumiIdentifier.decode(c.get("encoded").asText())).isEqualTo(parts);
    }
    assertThat(MasumiIdentifier.decode("")).isNull();
    assertThat(MasumiIdentifier.decode("abc")).isNull();
    assertThat(MasumiIdentifier.decode("ZZ")).isNull();
  }

  @Test
  void escrowDerivationMatchesTypeScript() {
    for (JsonNode c : V.get("escrow")) {
      JsonNode d = c.get("deployment");
      List<String> admins = new ArrayList<>();
      d.get("adminVkeys").forEach(n -> admins.add(n.asText()));
      var deployment =
          new MasumiDeployment(d.get("requiredAdmins").asText(), admins, d.get("cooldownPeriod").asText());
      assertThat(MasumiBlueprint.escrowScriptHash(deployment)).isEqualTo(c.get("scriptHash").asText());
      assertThat(MasumiBlueprint.escrowAddress(c.get("network").asText(), deployment))
          .isEqualTo(c.get("address").asText());
    }
    assertThat(MasumiBlueprint.resolveDeployment("cardano:preview", null)).isNull();
    assertThat(MasumiBlueprint.resolveDeployment("cardano:preprod", null)).isEqualTo(MasumiDeployment.DEFAULT);
  }

  @Test
  void scriptHashesMatchTypeScript() {
    for (JsonNode c : V.get("scriptHashes")) {
      @SuppressWarnings("unchecked")
      Map<String, Object> extra = (Map<String, Object>) json(c.get("extra"));
      if (c.has("error")) {
        assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(extra)).hasMessage(c.get("error").asText());
      } else {
        assertThat(ScriptAddresses.deriveScriptHashHex(extra)).as(c.toString()).isEqualTo(c.get("scriptHash").asText());
      }
    }
  }

  @Test
  void deterministicIssuanceByteMatchesTypeScript() {
    JsonNode seller = V.get("seller");
    CardanoSellerSigner signer = CardanoSellerSigner.fromMnemonic(seller.get("mnemonic").asText(), "cardano:preprod");
    PaymentRequirements issued =
        MasumiIssue.issue(
            MasumiIssue.Input.builder()
                .network("cardano:preprod")
                .asset("lovelace")
                .amount("5000000")
                .maxTimeoutSeconds(600)
                .sellerAddress(signer.sellerAddress())
                .signTerms(signer::signTerms)
                .commitment(
                    List.of(
                        new MasumiCommitmentInput(
                            "resource",
                            "jcs",
                            "application/json",
                            Map.of("url", "https://api.example.com/jobs"),
                            true)))
                .payByTime("1785756000000")
                .submitResultTime("1785756900000")
                .unlockTime("1785758100000")
                .externalDisputeUnlockTime("1785759300000")
                .sellerNonce("5a".repeat(32))
                .confirmationPolicy(Map.of("l1Confirmations", 0))
                .unsafeSkipPolicyChecks(true)
                .build());

    assertThat(X402Json.write(issued)).isEqualTo(X402Json.write(Vectors.requirements(seller.get("issued"))));
    assertThat((JsonNode) X402Json.mapper().valueToTree(issued)).isEqualTo(seller.get("issued"));
  }

  @Test
  void theLockDatumParsesToTheSignedTerms() {
    JsonNode datum = V.get("datum");
    PaymentRequirements requirements = Vectors.requirements(datum.get("requirements"));
    MasumiExtra extra = MasumiSchema.validate(requirements.extra(), requirements.network()).extra();

    MasumiDatum.View view = MasumiDatum.parse(HexFormat.of().parseHex(datum.get("datumHex").asText()));

    assertThat(view).isNotNull();
    assertThat(view.sellerNonce()).isEqualTo(extra.terms().sellerNonce());
    assertThat(view.referenceKey()).isEqualTo(extra.referenceKey());
    assertThat(view.inputHash()).isEqualTo(extra.terms().inputHash());
    assertThat(view.payByTime().toString()).isEqualTo(extra.terms().payByTime());
    assertThat(view.state()).isZero();
    assertThat(view.resultHash()).isEmpty();
    assertThat(CardanoAddresses.hashHex(view.seller().payment()))
        .isEqualTo(CardanoAddresses.hashHex(
            MasumiDatum.addressCredentials(extra.terms().sellerAddress()).payment()));
    assertThat(MasumiDatum.parse(new byte[] {0x00})).isNull();
  }
}
