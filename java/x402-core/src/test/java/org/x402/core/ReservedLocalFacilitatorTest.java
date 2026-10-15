package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;

import org.junit.jupiter.api.Test;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;

/** The identifier {@code local} is reserved for the in-process facilitator. */
class ReservedLocalFacilitatorTest {

  /** A remote-style client that claims the reserved name. */
  private static FacilitatorClient remoteNamed(String id) {
    return new FacilitatorClient() {
      @Override
      public VerifyResponse verify(PaymentPayload p, PaymentRequirements r) {
        return VerifyResponse.valid(null);
      }

      @Override
      public SettleResponse settle(PaymentPayload p, PaymentRequirements r) {
        return SettleResponse.success("tx", r.network(), null);
      }

      @Override
      public SupportedResponse getSupported() {
        return supported(kind(PREPROD));
      }

      @Override
      public String identifier() {
        return id;
      }
    };
  }

  @Test
  void aUserEntryNamedLocalIsRejected() {
    assertThatThrownBy(() -> X402ResourceServer.builder().facilitator(remoteNamed("local"))
        .build()).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("reserved");
    assertThatThrownBy(() -> X402ResourceServer.builder().facilitator(remoteNamed("local/"))
        .build()).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void theInProcessFacilitatorIsPrependedAsLocal() {
    FakeFacilitatorClient remote = new FakeFacilitatorClient("https://f.example",
        supported(kind(PREPROD)));
    FacilitatorClient inProcess = remoteNamed("whatever");
    X402ResourceServer server = X402ResourceServer.builder().facilitator(remote)
        .localFacilitator(inProcess).build();
    assertThat(server.facilitatorIdentifiers()).containsExactly("local", "https://f.example");
    assertThat(server.facilitator("local")).isSameAs(inProcess);
    assertThat(server.initialize().owner(2, PREPROD, "exact")).isEqualTo("local");
    assertThatThrownBy(() -> X402ResourceServer.builder().localFacilitator(inProcess)
        .localFacilitator(inProcess)).isInstanceOf(IllegalStateException.class);
  }

  @Test
  void anInProcessClientMayCarryTheReservedName() {
    class Local extends FakeFacilitatorClientDelegate implements InProcessFacilitatorClient {
      Local() {
        super(new FakeFacilitatorClient("local", supported(kind(MAINNET))));
      }
    }
    X402ResourceServer server = X402ResourceServer.builder().facilitator(new Local()).build();
    assertThat(server.facilitatorIdentifiers()).containsExactly("local");
  }

  /** Delegates every call to a fake. */
  abstract static class FakeFacilitatorClientDelegate implements FacilitatorClient {
    private final FacilitatorClient delegate;

    FakeFacilitatorClientDelegate(FacilitatorClient delegate) {
      this.delegate = delegate;
    }

    @Override
    public VerifyResponse verify(PaymentPayload p, PaymentRequirements r) {
      return delegate.verify(p, r);
    }

    @Override
    public SettleResponse settle(PaymentPayload p, PaymentRequirements r) {
      return delegate.settle(p, r);
    }

    @Override
    public SupportedResponse getSupported() {
      return delegate.getSupported();
    }

    @Override
    public String identifier() {
      return delegate.identifier();
    }
  }
}
