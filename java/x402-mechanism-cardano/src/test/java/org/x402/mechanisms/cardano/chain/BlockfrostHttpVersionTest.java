package org.x402.mechanisms.cardano.chain;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;

/**
 * The Blockfrost backend talks HTTP/1.1, so a plain-http Blockfrost-compatible service never sees
 * an h2c upgrade.
 */
class BlockfrostHttpVersionTest {

  @Test
  void aPlainHttpProviderSeesNoH2cUpgrade() throws IOException {
    List<String> upgrades = new CopyOnWriteArrayList<>();
    HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
    server.createContext("/", exchange -> {
      String upgrade = exchange.getRequestHeaders().getFirst("Upgrade");
      upgrades.add(upgrade == null ? "<none>" : upgrade);
      exchange.sendResponseHeaders(404, -1);
      exchange.close();
    });
    server.start();
    try {
      BlockfrostChainBackend backend = new BlockfrostChainBackend(
          BlockfrostChainBackend.Config.builder()
              .network("cardano:preprod")
              .baseUrl("http://127.0.0.1:" + server.getAddress().getPort())
              .projectId("preprodKey")
              .build());
      try {
        backend.getProtocolParameters("cardano:preprod");
      } catch (RuntimeException expected) {
        // the stub answers 404; only the request line and headers matter here
      }
    } finally {
      server.stop(0);
    }
    assertThat(upgrades).isNotEmpty().allMatch("<none>"::equals);
  }
}
