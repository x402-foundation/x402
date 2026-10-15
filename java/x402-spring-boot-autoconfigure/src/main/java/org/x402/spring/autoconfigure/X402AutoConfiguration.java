package org.x402.spring.autoconfigure;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesBinding;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.x402.core.FacilitatorClient;
import org.x402.core.InProcessFacilitatorClient;
import org.x402.core.client.PaymentPolicies;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.server.X402ResourceServer;
import org.x402.http.FacilitatorAuthProvider;
import org.x402.http.HostPolicy;
import org.x402.http.HttpFacilitatorClient;
import org.x402.http.PaywallConfig;
import org.x402.http.PaywallProvider;
import org.x402.http.RouteConfigurationError;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.X402ClientCustomizer;
import org.x402.spring.X402ClientSchemeDefaults;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.X402DynamicPayTo;
import org.x402.spring.X402DynamicPrice;
import org.x402.spring.X402FacilitatorAuthProvider;
import org.x402.spring.X402ResourceServerCustomizer;
import org.x402.spring.X402RouteCustomizer;
import org.x402.spring.X402RouteErrors;
import org.x402.spring.X402SchemeDefaults;
import org.x402.spring.X402ServerLifecycle;
import org.x402.spring.actuate.X402HealthIndicator;
import org.x402.spring.offer.OfferResolver;
import org.x402.spring.offer.OfferRouteResolver;
import org.x402.spring.offer.X402OptionContributor;
import org.x402.spring.offer.X402Offers;
import org.x402.spring.properties.PriceSpecConverter;
import org.x402.spring.properties.RawProperties;
import org.x402.spring.properties.X402Properties;

/**
 * Core x402 beans: the resource server with its facilitators, the resolved offers, the HTTP
 * server, startup sync and health; and the payment client. Every bean backs off when you define
 * your own. {@code x402.enabled=false} disables all of it.
 */
@AutoConfiguration
@ConditionalOnProperty(prefix = "x402", name = "enabled", havingValue = "true",
    matchIfMissing = true)
@EnableConfigurationProperties(X402Properties.class)
public class X402AutoConfiguration {

  private static final Log LOG = LogFactory.getLog(X402AutoConfiguration.class);

  /** The reserved identifier of the in-process facilitator. */
  public static final String LOCAL = "local";

  /**
   * Binds money strings to {@code price}.
   *
   * @return the converter
   */
  @Bean
  @ConfigurationPropertiesBinding
  static PriceSpecConverter x402PriceSpecConverter() {
    return new PriceSpecConverter();
  }

  /** The resource server (any web application). */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnWebApplication
  static class ResourceServerConfiguration {

    @Bean
    @ConditionalOnMissingBean
    X402ResourceServer x402ResourceServer(X402Properties properties,
        ObjectProvider<FacilitatorClient> facilitatorClients, ListableBeanFactory beans,
        ObjectProvider<X402ResourceServerCustomizer> customizers,
        ObjectProvider<X402SchemeDefaults> defaults) {
      X402ResourceServer.Builder builder = X402ResourceServer.builder();
      if (properties.localFacilitator()) {
        builder.localFacilitator(localFacilitator(facilitatorClients));
      }
      Set<String> seen = new LinkedHashSet<>();
      if (properties.localFacilitator()) {
        seen.add(LOCAL);
      }
      List<X402Properties.Facilitator> entries = properties.effectiveFacilitators();
      for (int i = 0; i < entries.size(); i++) {
        X402Properties.Facilitator entry = entries.get(i);
        if (entry == null || entry.url() == null || entry.url().isBlank()) {
          throw new X402ConfigurationException("x402.facilitators[" + i + "].url is required");
        }
        String id = entry.effectiveIdentifier();
        if (LOCAL.equals(id)) {
          throw new X402ConfigurationException("x402.facilitators[" + i + "]: identifier \""
              + LOCAL + "\" is reserved for the in-process facilitator (x402.local-facilitator)");
        }
        if (!seen.add(id)) {
          throw new X402ConfigurationException("x402.facilitators[" + i + "]: duplicate "
              + "facilitator identifier \"" + id + "\" (identifiers default to the url and are "
              + "compared without trailing slashes)");
        }
        builder.facilitator(HttpFacilitatorClient.builder().url(entry.url()).identifier(id)
            .timeout(entry.timeout()).verifyTimeout(entry.verifyTimeout())
            .authProvider(auth(i, entry, beans)).build());
      }
      X402ResourceServer server = builder.build();
      customizers.orderedStream().forEach(c -> c.customize(server));
      defaults.orderedStream().forEach(d -> d.registerDefaults(server));
      return server;
    }

    private static FacilitatorClient localFacilitator(ObjectProvider<FacilitatorClient> clients) {
      List<FacilitatorClient> all = clients.orderedStream().toList();
      List<FacilitatorClient> local = all.stream()
          .filter(c -> c instanceof InProcessFacilitatorClient).toList();
      if (local.isEmpty()) {
        local = all.stream().filter(c -> LOCAL.equals(
            X402Properties.Facilitator.normalize(c.identifier()))).toList();
      }
      if (local.size() != 1) {
        throw new X402ConfigurationException("x402.local-facilitator=true needs exactly one "
            + "in-process facilitator client; enable x402.facilitator-server (it supplies one), "
            + "or define a FacilitatorClient bean with identifier \"local\" (found "
            + local.size() + ")");
      }
      return local.get(0);
    }

    private static FacilitatorAuthProvider auth(int index, X402Properties.Facilitator entry,
        ListableBeanFactory beans) {
      if (entry.authRef() != null && !entry.authRef().isBlank()) {
        if (!beans.containsBean(entry.authRef())) {
          throw new X402ConfigurationException("x402.facilitators[" + index + "].auth-ref: no "
              + "X402FacilitatorAuthProvider bean named \"" + entry.authRef() + "\"");
        }
        return beans.getBean(entry.authRef(), X402FacilitatorAuthProvider.class);
      }
      X402Properties.FacilitatorHeaders h = entry.headers();
      if (h == null || (empty(h.verify()) && empty(h.settle()) && empty(h.supported()))) {
        return null;
      }
      return FacilitatorAuthProvider.of(new FacilitatorAuthProvider.AuthHeaders(h.verify(),
          h.settle(), h.supported()));
    }

    private static boolean empty(Map<String, String> m) {
      return m == null || m.isEmpty();
    }

    @Bean
    @ConditionalOnMissingBean
    X402Offers x402Offers(X402Properties properties, Environment environment,
        X402ResourceServer server, ObjectProvider<X402OptionContributor> contributors,
        ObjectProvider<X402RouteCustomizer> routeCustomizers, ListableBeanFactory beans) {
      X402Offers offers = OfferResolver.builder(properties)
          .presence(RawProperties.presence(environment))
          .facilitators(server.facilitatorIdentifiers())
          .contributors(contributors.orderedStream().toList())
          .routeCustomizers(routeCustomizers.orderedStream().toList())
          .priceRefs(name -> beans.containsBean(name)
              ? beans.getBean(name, X402DynamicPrice.class) : null)
          .payToRefs(name -> beans.containsBean(name)
              ? beans.getBean(name, X402DynamicPayTo.class) : null)
          .server(server)
          .build().resolve();
      offers.warnings().forEach(LOG::warn);
      return offers;
    }

    @Bean
    @ConditionalOnMissingBean
    OfferRouteResolver x402RouteResolver(X402Offers offers) {
      return new OfferRouteResolver(offers);
    }

    @Bean
    @ConditionalOnMissingBean
    X402HttpResourceServer x402HttpResourceServer(X402ResourceServer server,
        OfferRouteResolver routes, ObjectProvider<PaywallProvider> paywall,
        ObjectProvider<X402ResourceServerCustomizer> customizers) {
      X402HttpResourceServer http;
      try {
        http = new X402HttpResourceServer(server, routes);
      } catch (RouteConfigurationError e) {
        throw X402RouteErrors.withOfferNames(e);
      }
      paywall.ifAvailable(http::registerPaywallProvider);
      customizers.orderedStream().forEach(c -> c.customizeHttp(http));
      return http;
    }

    @Bean
    @ConditionalOnMissingBean
    PaywallConfig x402PaywallConfig(X402Properties properties) {
      X402Properties.Paywall p = properties.paywall();
      return new PaywallConfig(p.appName(), p.appLogo(), null, null, p.testnet());
    }

    @Bean
    @ConditionalOnMissingBean
    X402ServerLifecycle x402ServerLifecycle(X402HttpResourceServer http, X402Offers offers,
        X402Properties properties) {
      return new X402ServerLifecycle(http, !offers.isEmpty(), properties.sync());
    }

    /** The {@code x402} health component. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(HealthIndicator.class)
    @ConditionalOnProperty(prefix = "management.health.x402", name = "enabled",
        havingValue = "true", matchIfMissing = true)
    static class HealthConfiguration {

      @Bean
      @ConditionalOnMissingBean(name = "x402HealthIndicator")
      X402HealthIndicator x402HealthIndicator(X402ServerLifecycle lifecycle) {
        return new X402HealthIndicator(lifecycle);
      }
    }
  }

  /** The payment client ({@code x402.client.enabled=true}). */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnProperty(prefix = "x402.client", name = "enabled", havingValue = "true")
  static class ClientConfiguration {

    @Bean
    @ConditionalOnMissingBean
    X402Client x402Client(X402Properties properties,
        ObjectProvider<X402ClientCustomizer> customizers,
        ObjectProvider<X402ClientSchemeDefaults> defaults) {
      X402Properties.Client config = properties.client();
      X402Client client = new X402Client();
      client.setSpendControls(spendControls(config.spendControls()));
      if (!config.prefer().schemes().isEmpty()) {
        client.registerPolicy(PaymentPolicies.preferScheme(
            config.prefer().schemes().toArray(String[]::new)));
      }
      if (!config.prefer().networks().isEmpty()) {
        client.registerPolicy(PaymentPolicies.preferNetwork(
            config.prefer().networks().toArray(String[]::new)));
      }
      customizers.orderedStream().forEach(c -> c.customize(client));
      defaults.orderedStream().forEach(d -> d.registerDefaults(client));
      return client;
    }

    private static SpendControls spendControls(X402Properties.SpendControlsProperties p) {
      if (!p.enabled()) {
        return SpendControls.disabled();
      }
      List<SpendControls.AllowedAsset> allowed = new ArrayList<>();
      for (int i = 0; i < p.allowedAssets().size(); i++) {
        X402Properties.AllowedAsset a = p.allowedAssets().get(i);
        if (a == null || a.network() == null || a.asset() == null) {
          throw new X402ConfigurationException("x402.client.spend-controls.allowed-assets[" + i
              + "] needs network and asset");
        }
        allowed.add(new SpendControls.AllowedAsset(a.network(), a.asset(),
            a.maxAmountPerPayment()));
      }
      SpendControls.Builder b = SpendControls.builder().allowedAssets(allowed);
      if (p.maxAmountPerPayment() == null || p.maxAmountPerPayment().isBlank()) {
        LOG.warn("x402.client.spend-controls.max-amount-per-payment is empty: payments in the "
            + "network's default asset have no USD cap");
        b.noUsdCap();
      } else {
        b.maxAmountPerPayment(p.maxAmountPerPayment());
      }
      if (p.allowAnyAsset()) {
        b.allowAnyAsset();
      }
      return b.build();
    }

    @Bean
    @ConditionalOnMissingBean(name = "x402ClientHostPolicy")
    HostPolicy x402ClientHostPolicy(X402Properties properties) {
      List<String> hosts = properties.client().hosts();
      if (hosts.isEmpty()) {
        LOG.warn("x402.client.enabled=true but x402.client.hosts is empty: no automatic payment "
            + "will be made. List the hosts allowed to charge you (api.example.com, "
            + "*.example.com).");
      }
      return HostPolicy.of(hosts);
    }
  }
}
