package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PREPROD;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.VerifyResponse;

/** Facilitator routing: first registered scheme matching scheme + network. */
class FacilitatorRoutingTest {

  private static PaymentRequirements req(String scheme, String network) {
    return new PaymentRequirements(scheme, network, "USDM", "1", "p", 300, null);
  }

  @Test
  void theFirstRegisteredMatchingSchemeWins() {
    FakeFacilitatorScheme first = new FakeFacilitatorScheme();
    FakeFacilitatorScheme second = new FakeFacilitatorScheme();
    X402Facilitator facilitator = new X402Facilitator()
        .register(PREPROD, first)
        .register(List.of(PREPROD, MAINNET), second);
    facilitator.verify(Fixtures.payload(req("exact", PREPROD)), req("exact", PREPROD));
    facilitator.settle(Fixtures.payload(req("exact", MAINNET)), req("exact", MAINNET));
    assertThat(first.calls).containsExactly("verify:cardano:preprod");
    assertThat(second.calls).containsExactly("settle:cardano:mainnet");
  }

  @Test
  void severalNetworksOfOneNamespaceMatchByWildcardPatternLikeTs() {
    FakeFacilitatorScheme scheme = new FakeFacilitatorScheme();
    X402Facilitator facilitator = new X402Facilitator().register(List.of(PREPROD, MAINNET), scheme);
    facilitator.verify(Fixtures.payload(req("exact", "cardano:preview")),
        req("exact", "cardano:preview"));
    assertThat(scheme.calls).containsExactly("verify:cardano:preview");
    assertThat(facilitator.getSupported().kinds()).extracting(k -> k.network())
        .containsExactly(PREPROD, MAINNET);
  }

  @Test
  void mixedNamespacesMatchOnlyTheirExactNetworksPlusTheFirst() {
    FakeFacilitatorScheme scheme = new FakeFacilitatorScheme();
    X402Facilitator facilitator =
        new X402Facilitator().register(List.of(PREPROD, "eip155:8453"), scheme);
    facilitator.verify(Fixtures.payload(req("exact", "eip155:8453")), req("exact", "eip155:8453"));
    assertThatThrownBy(() -> facilitator.verify(Fixtures.payload(req("exact", "eip155:1")),
        req("exact", "eip155:1")))
        .hasMessage("No facilitator registered for scheme: exact and network: eip155:1");
  }

  @Test
  void unregisteredSchemeOrVersionFails() {
    X402Facilitator facilitator = new X402Facilitator().register(PREPROD,
        new FakeFacilitatorScheme());
    assertThatThrownBy(() -> facilitator.settle(Fixtures.payload(req("upto", PREPROD)),
        req("upto", PREPROD)))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("No facilitator registered for scheme: upto and network: cardano:preprod");
    PaymentPayload v1 = new PaymentPayload(1, ResourceInfo.of("u"), req("exact", PREPROD),
        null, null);
    assertThatThrownBy(() -> facilitator.verify(v1, req("exact", PREPROD)))
        .hasMessage("No facilitator registered for x402 version: 1");
    assertThat(new X402Facilitator().getSupported().kinds()).isEmpty();
  }

  @Test
  void emptyNetworkListRegistersNothingRoutable() {
    FakeFacilitatorScheme scheme = new FakeFacilitatorScheme();
    scheme.verify = (r, c) -> VerifyResponse.valid(null);
    X402Facilitator facilitator = new X402Facilitator().register(List.of(), scheme);
    assertThatThrownBy(() -> facilitator.verify(Fixtures.payload(req("exact", PREPROD)),
        req("exact", PREPROD))).isInstanceOf(IllegalArgumentException.class);
  }
}
