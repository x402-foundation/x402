package org.x402.core.client;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;

/** {@code X402Client.hasRegisteredScheme}: exact keys and patterns, per protocol version 2. */
class ClientSchemeLookupTest {

  @Test
  void findsExactAndPatternRegistrations() {
    X402Client client = new X402Client()
        .register("cardano:preprod", new FakeClientScheme())
        .register("eip155:*", new FakeClientScheme());

    assertThat(client.hasRegisteredScheme("cardano:preprod", "exact")).isTrue();
    assertThat(client.hasRegisteredScheme("cardano:mainnet", "exact")).isFalse();
    assertThat(client.hasRegisteredScheme("eip155:8453", "exact")).isTrue();
    assertThat(client.hasRegisteredScheme("cardano:preprod", "upto")).isFalse();
  }
}
