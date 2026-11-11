package org.x402.spring.cardano;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import org.x402.core.server.X402ResourceServer;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.exact.masumi.InMemoryMasumiTermsStorage;
import org.x402.mechanisms.cardano.exact.masumi.MasumiTermsStorage;
import org.x402.mechanisms.cardano.exact.server.CardanoSellerSigner;
import org.x402.mechanisms.cardano.exact.server.ExactCardanoServerConfig;
import org.x402.mechanisms.cardano.exact.server.ExactCardanoServerScheme;
import org.x402.mechanisms.cardano.exact.server.MasumiIssuerConfig;
import org.x402.spring.X402SchemeDefaults;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.properties.X402Properties;

/**
 * Cardano from YAML on the resource-server side: one {@link GuardedCardanoServerScheme}
 * per used Cardano network, registered after every customizer and only where no scheme answers
 * yet (a customizer's {@code cardano:*} or exact registration wins), Masumi sellers per network,
 * the in-memory {@link MasumiTermsStorage} (correct for a single instance only), and the {@link
 * CardanoOptionContributor}.
 */
@AutoConfiguration(after = X402AutoConfiguration.class)
@ConditionalOnClass(ExactCardanoServerScheme.class)
@ConditionalOnBean(X402ResourceServer.class)
public class X402CardanoAutoConfiguration {

  @Bean
  @ConditionalOnMissingBean
  X402CardanoProperties x402CardanoProperties(Environment environment) {
    return X402CardanoProperties.bind(environment);
  }

  @Bean
  @ConditionalOnMissingBean
  MasumiTermsStorage x402MasumiTermsStorage() {
    return new InMemoryMasumiTermsStorage();
  }

  @Bean
  @ConditionalOnMissingBean
  CardanoServerPlan x402CardanoServerPlan(X402Properties properties,
      X402CardanoProperties cardano, ObjectProvider<X402CardanoNetworkBeans> networkBeans,
      ObjectProvider<CardanoSellerSigner> sellerBean) {
    return new CardanoServerPlan(properties, cardano, networkBeans, sellerBean);
  }

  @Bean
  X402SchemeDefaults x402CardanoSchemes(CardanoServerPlan plan, MasumiTermsStorage storage) {
    return server -> {
      Map<String, GuardedCardanoServerScheme> byNetwork = new LinkedHashMap<>();
      for (String network : plan.networks()) {
        ExactCardanoServerConfig.Builder config = ExactCardanoServerConfig.builder()
            .masumiStorage(storage);
        CardanoSellerSigner seller = plan.seller(network);
        if (seller != null) {
          CardanoServerPlan.MasumiSettings s = plan.settings(network);
          MasumiIssuerConfig.Builder issuer = MasumiIssuerConfig.builder().seller(seller)
              .sellerReturnAddress(s.sellerReturnAddress()).deployment(s.deployment());
          if (s.agentIdentifier() != null) {
            issuer.agentIdentifier(s.agentIdentifier());
          }
          config.masumi(issuer.build());
        }
        byNetwork.put(network, new GuardedCardanoServerScheme(config.build(), plan::escrows,
            plan::escrowScripts));
      }
      for (String written : plan.writtenNetworks()) {
        if (server.getRegisteredScheme(written, "exact") == null) {
          server.register(written, byNetwork.get(CardanoNetworks.normalize(written)));
        }
      }
    };
  }

  @Bean
  CardanoOptionContributor x402CardanoOptionContributor(CardanoServerPlan plan) {
    return new CardanoOptionContributor(plan);
  }
}
