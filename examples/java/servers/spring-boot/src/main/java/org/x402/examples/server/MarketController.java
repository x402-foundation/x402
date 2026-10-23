package org.x402.examples.server;

import java.util.Map;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.spring.annotation.X402Payment;

/**
 * Paid with {@code x402.routes.market}, an offer accepting preprod and mainnet. It exists only in
 * the {@code mainnet} profile, because the offer lives in {@code application-mainnet.yml} (an
 * annotation naming an unknown offer fails startup).
 */
@RestController
@Profile("mainnet")
class MarketController {

  @GetMapping("/market")
  @X402Payment("market")
  Map<String, Object> market() {
    return Map.of("ada", "0.71 USD", "source", "example data");
  }
}
