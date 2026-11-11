package org.x402.examples.restclient;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.HttpExchange;

/**
 * The paid API as a declarative HTTP interface. Nothing x402-specific: the proxy is built on a
 * {@code RestClient} from Boot's builder, which pays 402s for the hosts in {@code
 * x402.client.hosts}.
 */
@HttpExchange
public interface PaidApi {

  /** {@code ResponseEntity} keeps the headers, including {@code PAYMENT-RESPONSE}. */
  @GetExchange("/weather")
  ResponseEntity<Map<String, Object>> weather();

  @GetExchange("/report")
  ResponseEntity<Map<String, Object>> report();
}
