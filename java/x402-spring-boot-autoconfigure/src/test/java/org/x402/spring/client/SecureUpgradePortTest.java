package org.x402.spring.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import org.junit.jupiter.api.Test;

/**
 * A paid request is re-sent only over a same-host http-to-https upgrade on the default ports;
 * another port is another origin, as in the plain-Java client.
 */
class SecureUpgradePortTest {

  private static boolean upgrade(String from, String to) {
    return TransportRedirects.secureUpgrade(URI.create(from), URI.create(to));
  }

  @Test
  void theDefaultPortsUpgrade() {
    assertThat(upgrade("http://api.example.com/x", "https://api.example.com/x")).isTrue();
    assertThat(upgrade("http://API.example.com:80/x", "https://api.example.com:443/x")).isTrue();
  }

  @Test
  void anotherPortIsNotTheSameOrigin() {
    assertThat(upgrade("http://api.example.com:8080/x", "https://api.example.com/x")).isFalse();
    assertThat(upgrade("http://api.example.com/x", "https://api.example.com:8443/x")).isFalse();
  }

  @Test
  void anotherHostOrADowngradeIsNot() {
    assertThat(upgrade("http://api.example.com/x", "https://cdn.example.com/x")).isFalse();
    assertThat(upgrade("https://api.example.com/x", "http://api.example.com/x")).isFalse();
    assertThat(upgrade("http://api.example.com/x", "http://api.example.com/y")).isFalse();
  }
}
