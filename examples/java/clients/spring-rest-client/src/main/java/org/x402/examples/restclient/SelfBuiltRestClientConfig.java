package org.x402.examples.restclient;

import java.net.http.HttpClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactoryDecorator;

/**
 * A {@code RestClient} you build yourself (not from Boot's builder) does not pay on its own: x402
 * cannot wrap its factory afterwards and only logs a warning. Give it a paying factory when you
 * build it. The second factory is the same transport with redirects off; the request carrying
 * {@code PAYMENT-SIGNATURE} goes through it, so a payment is never forwarded by a redirect.
 */
@Configuration
class SelfBuiltRestClientConfig {

  @Bean
  RestClient selfBuiltRestClient(X402ClientHttpRequestFactoryDecorator x402Decorator,
      @Value("${example.base-url}") String baseUrl) {
    HttpClient following = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NORMAL).build();
    HttpClient notFollowing = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER).build();
    return RestClient.builder()
        .baseUrl(baseUrl)
        .requestFactory(x402Decorator.decorate(
            new JdkClientHttpRequestFactory(following),
            new JdkClientHttpRequestFactory(notFollowing)))
        .build();
  }
}
