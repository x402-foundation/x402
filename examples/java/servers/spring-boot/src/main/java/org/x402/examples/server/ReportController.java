package org.x402.examples.server;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.spring.annotation.X402Payment;

/** Paid with {@code x402.routes.report}: the buyer picks USDM, ADA or a Masumi escrow payment. */
@RestController
class ReportController {

  @GetMapping("/report")
  @X402Payment("report")
  Map<String, Object> report() {
    return Map.of("title", "Cardano market report",
        "highlights", List.of("USDM supply up", "Fees stable"));
  }
}
