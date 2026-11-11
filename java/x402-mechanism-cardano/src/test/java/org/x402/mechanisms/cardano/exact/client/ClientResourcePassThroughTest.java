package org.x402.mechanisms.cardano.exact.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/** The signer sees the resource of the 402, which a Masumi quote's agent identifier binds to. */
class ClientResourcePassThroughTest {

  @Test
  void theSignerReceivesTheResource() {
    AtomicReference<ResourceInfo> seen = new AtomicReference<>();
    ClientCardanoSigner signer = new ClientCardanoSigner() {
      @Override
      public String getAddress() {
        return TxBuilder.walletAddress();
      }

      @Override
      public ClientCardanoSignResult buildAndSignPaymentTransaction(ClientCardanoSignInput input) {
        seen.set(input.resource());
        return new ClientCardanoSignResult("AA==", TxBuilder.hash32(1) + "#0");
      }
    };
    X402Client client = new X402Client().register("cardano:*", new ExactCardanoClientScheme(signer))
        .setSpendControls(SpendControls.disabled());
    ResourceInfo resource = ResourceInfo.of("https://api.example.com/jobs");
    PaymentRequirements requirements = new PaymentRequirements("exact", "cardano:preprod", "lovelace",
        "1000000", TxBuilder.walletAddress(), 600, Map.of());

    client.createPaymentPayload(new PaymentRequired(2, null, resource, List.of(requirements), null));

    assertThat(seen.get()).isEqualTo(resource);
  }
}
