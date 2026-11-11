package org.x402.examples.restclient;

import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.support.RestClientAdapter;
import org.springframework.web.service.invoker.HttpServiceProxyFactory;
import org.x402.core.types.SettleResponse;
import org.x402.http.HeaderCodec;

/**
 * Pays x402 endpoints from Spring. Everything x402 lives in {@code application.yml} ({@code
 * x402.client.*}); the code is plain Spring: a {@code RestClient} from Boot's builder and an
 * {@code @HttpExchange} interface on top of it.
 */
@SpringBootApplication
public class RestClientExampleApplication {

  public static void main(String[] args) {
    SpringApplication.run(RestClientExampleApplication.class, args);
  }

  /**
   * The paid API. The {@code RestClient} must come from the injected {@code RestClient.Builder}:
   * that builder carries x402. {@code RestClient.create()} would not pay.
   */
  @Bean
  PaidApi paidApi(RestClient.Builder builder, @Value("${example.base-url}") String baseUrl) {
    RestClient restClient = builder.baseUrl(baseUrl).build();
    return HttpServiceProxyFactory.builderFor(RestClientAdapter.create(restClient)).build()
        .createClient(PaidApi.class);
  }

  /** Calls the endpoint named by {@code example.endpoint} once and prints the result. */
  @Bean
  @ConditionalOnProperty(name = "example.call-on-startup", havingValue = "true",
      matchIfMissing = true)
  CommandLineRunner callOnce(PaidApi api, @Value("${example.endpoint:weather}") String endpoint) {
    return args -> {
      ResponseEntity<Map<String, Object>> response =
          "report".equals(endpoint) ? api.report() : api.weather();
      System.out.println("HTTP " + response.getStatusCode().value() + " " + response.getBody());
      String header = response.getHeaders().getFirst("PAYMENT-RESPONSE");
      if (header != null) {
        SettleResponse settled = HeaderCodec.decodePaymentResponse(header);
        System.out.println("paid: success=" + settled.success() + " transaction="
            + settled.transaction() + " network=" + settled.network());
      }
    };
  }
}
