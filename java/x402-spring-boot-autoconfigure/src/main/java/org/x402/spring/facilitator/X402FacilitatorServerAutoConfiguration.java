package org.x402.spring.facilitator;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.x402.core.FacilitatorExtension;
import org.x402.core.PendingSettlementStore;
import org.x402.core.facilitator.InMemoryPendingSettlementStore;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.types.SupportedKind;
import org.x402.core.utils.Networks;
import org.x402.http.facilitator.FacilitatorHttpHandler;
import org.x402.http.facilitator.LocalFacilitatorClient;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;
import org.x402.mechanisms.cardano.exact.facilitator.InMemorySettlementClaimStore;
import org.x402.mechanisms.cardano.exact.facilitator.SettlementClaimStore;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeploymentValidator;
import org.x402.mechanisms.cardano.exact.masumi.MasumiRegistryValidator;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.cardano.X402CardanoNetworkBeans;

/**
 * The Spring facilitator server (beyond parity with other SDKs): an {@link X402Facilitator} built
 * from {@code x402.facilitator-server.*}, the framework-free {@link FacilitatorHttpHandler}, HTTP
 * endpoints on WebMvc or WebFlux, and a {@link LocalFacilitatorClient} for {@code
 * x402.local-facilitator=true}. Every bean backs off for your own. Independent of {@code
 * x402.enabled}; no built-in authentication (use Spring Security, and exempt the base path from
 * CSRF).
 */
@AutoConfiguration(before = X402AutoConfiguration.class)
@ConditionalOnProperty(prefix = "x402.facilitator-server", name = "enabled", havingValue = "true")
@EnableConfigurationProperties(X402FacilitatorServerProperties.class)
public class X402FacilitatorServerAutoConfiguration {

  private static final Log LOG = LogFactory.getLog(X402FacilitatorServerAutoConfiguration.class);

  /** The resource servers' default facilitator timeout minus a margin. */
  static final Duration CONFIRMATION_WARNING = Duration.ofSeconds(85);

  @Bean
  @ConditionalOnMissingBean
  PendingSettlementStore x402PendingSettlementStore(ObjectProvider<Clock> clock) {
    return new InMemoryPendingSettlementStore(clock.getIfAvailable(Clock::systemUTC));
  }

  @Bean
  @ConditionalOnMissingBean
  X402Facilitator x402Facilitator(ObjectProvider<X402FacilitatorCustomizer> customizers,
      ObjectProvider<FacilitatorExtension> extensions) {
    X402Facilitator facilitator = new X402Facilitator();
    customizers.orderedStream().forEach(c -> c.customize(facilitator));
    extensions.orderedStream().forEach(facilitator::registerExtension);
    return facilitator;
  }

  @Bean
  @ConditionalOnMissingBean
  FacilitatorHttpHandler x402FacilitatorHttpHandler(X402Facilitator facilitator,
      X402FacilitatorServerProperties properties) {
    return new FacilitatorHttpHandler(facilitator, properties.basePath());
  }

  @Bean
  @ConditionalOnMissingBean
  @ConditionalOnProperty(prefix = "x402", name = "local-facilitator", havingValue = "true")
  LocalFacilitatorClient x402LocalFacilitatorClient(X402Facilitator facilitator) {
    return new LocalFacilitatorClient(facilitator);
  }

  /** The Cardano facilitator schemes. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnClass(ExactCardanoFacilitatorScheme.class)
  static class CardanoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    SettlementClaimStore x402SettlementClaimStore(ObjectProvider<Clock> clock) {
      return new InMemorySettlementClaimStore(InMemorySettlementClaimStore.DEFAULT_MAX_ENTRIES,
          clock.getIfAvailable(Clock::systemUTC));
    }

    @Bean
    @ConditionalOnMissingBean
    CardanoFacilitatorSchemes x402CardanoFacilitatorSchemes(
        X402FacilitatorServerProperties properties, SettlementClaimStore store,
        ObjectProvider<MasumiRegistryValidator> registry,
        ObjectProvider<MasumiDeploymentValidator> deployment, ObjectProvider<Clock> clock,
        ObjectProvider<X402CardanoNetworkBeans> networkBeans,
        ObjectProvider<CardanoChainBackend> backend) {
      X402FacilitatorServerProperties.Cardano cardano = properties.cardano();
      if (cardano.confirmationTimeout().compareTo(CONFIRMATION_WARNING) > 0) {
        LOG.warn("x402.facilitator-server.cardano.confirmation-timeout is "
            + cardano.confirmationTimeout().toSeconds() + " s, above 85 s: resource servers "
            + "time out facilitator calls after 90 s by default, so a slow confirmation would "
            + "look like a failed settle to them");
      }
      return new CardanoFacilitatorSchemes(cardano, store, registry.getIfAvailable(),
          deployment.getIfAvailable(), clock.getIfAvailable(Clock::systemUTC), networkBeans,
          backend);
    }

    /**
     * Registers the configured Cardano networks last, so a scheme a user customizer registered
     * for the same scheme and network takes precedence.
     */
    @Bean
    @Order(Ordered.LOWEST_PRECEDENCE)
    X402FacilitatorCustomizer x402CardanoFacilitatorDefaults(CardanoFacilitatorSchemes schemes) {
      return facilitator -> {
        List<SupportedKind> claimed = facilitator.getSupported().kinds();
        for (String network : schemes.networks()) {
          ExactCardanoFacilitatorScheme scheme = schemes.forNetwork(network);
          boolean taken = claimed.stream().anyMatch(k -> scheme.scheme().equals(k.scheme())
              && Networks.matchesPattern(k.network(), network));
          if (!taken) {
            // Requests may name the network by its CIP-34 alias too.
            String alias = CardanoNetworks.cip34Alias(network);
            facilitator.register(alias == null ? List.of(network) : List.of(network, alias), scheme);
          }
        }
      };
    }
  }

  /** The {@code x402-facilitator} health component. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnClass(name = {"org.springframework.boot.actuate.health.HealthIndicator",
      "org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme"})
  @ConditionalOnProperty(prefix = "management.health.x402-facilitator", name = "enabled",
      havingValue = "true", matchIfMissing = true)
  static class HealthConfiguration {

    @Bean("x402-facilitatorHealthIndicator")
    @ConditionalOnMissingBean(name = "x402-facilitatorHealthIndicator")
    X402FacilitatorHealthIndicator x402FacilitatorHealthIndicator(
        CardanoFacilitatorSchemes schemes) {
      return new X402FacilitatorHealthIndicator(schemes);
    }
  }

  /** The HTTP endpoints on WebMvc. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
  @ConditionalOnClass(name = "org.springframework.web.servlet.function.RouterFunction")
  @ConditionalOnProperty(prefix = "x402.facilitator-server", name = "expose-http",
      havingValue = "true", matchIfMissing = true)
  static class MvcEndpoints {

    @Bean
    @ConditionalOnMissingBean(name = "x402FacilitatorRoutes")
    org.springframework.web.servlet.function.RouterFunction<
        org.springframework.web.servlet.function.ServerResponse> x402FacilitatorRoutes(
        FacilitatorHttpHandler handler) {
      return FacilitatorRoutes.mvc(handler);
    }
  }

  /** The HTTP endpoints on WebFlux, offloaded to {@code boundedElastic}. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.REACTIVE)
  @ConditionalOnClass(name = "org.springframework.web.reactive.function.server.RouterFunction")
  @ConditionalOnProperty(prefix = "x402.facilitator-server", name = "expose-http",
      havingValue = "true", matchIfMissing = true)
  static class WebFluxEndpoints {

    @Bean
    @ConditionalOnMissingBean(name = "x402FacilitatorRoutes")
    org.springframework.web.reactive.function.server.RouterFunction<
        org.springframework.web.reactive.function.server.ServerResponse> x402FacilitatorRoutes(
        FacilitatorHttpHandler handler) {
      return FacilitatorRoutes.webflux(handler);
    }
  }
}
