package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PAY_TO;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.core.json.X402Json;
import org.x402.core.server.FacilitatorCapabilityError;
import org.x402.core.server.FacilitatorRoute;
import org.x402.core.server.ResourceConfig;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerVerifyResult;
import org.x402.core.server.SettlementRouting;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentRequirements;

/** A pinned option builds, verifies and settles only via its facilitator. */
class FacilitatorPinningTest {

  private final FakeServerScheme scheme = new FakeServerScheme();
  private final FakeFacilitatorClient a =
      new FakeFacilitatorClient("A", supported(kind(PREPROD, map("feePayer", "fa"))));
  private final FakeFacilitatorClient b = new FakeFacilitatorClient("https://b.example",
      supported(List.of("ext-b"), kind(PREPROD, map("feePayer", "fb")), kind(MAINNET)));
  private final X402ResourceServer server =
      X402ResourceServer.builder().facilitators(List.of(a, b)).build();

  private PaymentRequirements build(String pin) {
    server.register(PREPROD, scheme);
    server.register(MAINNET, scheme);
    server.initialize();
    return server.buildPaymentRequirements(
        ResourceConfig.of("exact", PREPROD, PAY_TO, new Money("$0.01")).withFacilitator(pin))
        .get(0);
  }

  @Test
  void unpinnedOptionUsesTheOwnersKind() {
    PaymentRequirements r = build(null);
    assertThat(r.extra()).containsEntry("feePayer", "fa");
    assertThat(server.buildFacilitator(ResourceConfig.of("exact", PREPROD, PAY_TO,
        new Money("$1")), server.snapshot())).isEqualTo("A");
  }

  @Test
  void pinnedOptionCarriesThePinnedFacilitatorsKindAndExtensions() {
    PaymentRequirements r = build("https://b.example/");
    assertThat(r.extra()).containsEntry("feePayer", "fb");
    assertThat(scheme.enhancedExtensions).containsExactly(List.of("ext-b"));
    assertThat(X402Json.write(r)).doesNotContain("facilitator").doesNotContain("b.example");
  }

  @Test
  void pinnedVerifyAndSettleUseOnlyThePin() {
    PaymentRequirements r = build("https://b.example");
    ServerVerifyResult v = server.verifyPayment(Fixtures.payload(r), r, null, null,
        FacilitatorRoute.pinned("https://b.example"), null);
    assertThat(v.verifiedBy()).isEqualTo("https://b.example");
    server.settlePayment(Fixtures.payload(r), r, null, null, null, SettlePhase.AFTER_HANDLER,
        new SettlementRouting(FacilitatorRoute.pinned("https://b.example"), null, null));
    assertThat(b.verifyCalls).hasValue(1);
    assertThat(b.settleCalls).hasValue(1);
    assertThat(a.calls()).isZero();
  }

  @Test
  void unknownPinIsAnIllegalArgument() {
    build(null);
    assertThatThrownBy(() -> server.buildPaymentRequirements(
        ResourceConfig.of("exact", PREPROD, PAY_TO, new Money("$1")).withFacilitator("C")))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("C")
        .hasMessageContaining("A, https://b.example");
    PaymentRequirements r = Fixtures.requirements();
    assertThatThrownBy(() -> server.verifyPayment(Fixtures.payload(r), r, null, null,
        FacilitatorRoute.pinned("C"), null)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> server.settlePayment(Fixtures.payload(r), r, null, null, null,
        SettlePhase.AFTER_HANDLER, new SettlementRouting(FacilitatorRoute.pinned("C"), null,
            null))).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void pinnedFacilitatorWithoutTheKindCannotBuild() {
    server.register(MAINNET, scheme);
    server.register(PREPROD, scheme);
    server.initialize();
    assertThatThrownBy(() -> server.buildPaymentRequirements(
        ResourceConfig.of("exact", MAINNET, PAY_TO, new Money("$1")).withFacilitator("A")))
        .isInstanceOf(FacilitatorCapabilityError.class)
        .hasMessageContaining("A")
        .hasMessageContaining("exact on cardano:mainnet");
  }

  @Test
  void pinnedFacilitatorCapabilityIsCheckedWithItsOwnKind() {
    scheme.capabilityCheck = k -> "fb".equals(k.extra() == null ? null : k.extra().get("feePayer"))
        ? "fee payer fb unsupported" : null;
    assertThatThrownBy(() -> build("https://b.example"))
        .isInstanceOf(FacilitatorCapabilityError.class)
        .hasMessageContaining("https://b.example")
        .hasMessageContaining("fee payer fb unsupported");
  }
}
