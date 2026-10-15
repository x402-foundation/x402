package org.x402.e2e.server.mvc;

import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.e2e.server.E2eServerConfig;
import org.x402.spring.annotation.X402Payment;

/** Serves one catalog route through {@code @X402Payment}, so the annotation path runs in e2e. */
@RestController
@ConditionalOnProperty(name = E2eServerConfig.ANNOTATED_ROUTE_PROPERTY, havingValue = "true")
class AnnotatedRouteController {

  @GetMapping("${" + E2eServerConfig.ANNOTATED_PATH_PROPERTY + "}")
  @X402Payment(E2eServerConfig.ANNOTATED_OFFER)
  Map<String, Object> paid() {
    return E2eServerConfig.successBody();
  }
}
