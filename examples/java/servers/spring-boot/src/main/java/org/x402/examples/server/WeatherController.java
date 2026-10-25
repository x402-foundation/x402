package org.x402.examples.server;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.spring.annotation.X402Payment;

/** An ordinary controller; one annotation makes {@code /weather} paid. */
@RestController
class WeatherController {

  /** Free: no annotation, no offer. */
  @GetMapping("/free")
  Map<String, Object> free() {
    return Map.of("message", "This endpoint is free");
  }

  /** Paid with the single-option offer {@code x402.routes.weather}. */
  @GetMapping("/weather")
  @X402Payment("weather")
  Map<String, Object> weather() {
    return Map.of("city", "Lisbon", "weather", "sunny", "temperature", 24);
  }
}
