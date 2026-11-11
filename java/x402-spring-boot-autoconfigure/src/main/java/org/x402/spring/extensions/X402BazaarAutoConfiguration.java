package org.x402.spring.extensions;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.x402.core.server.X402ResourceServer;
import org.x402.extensions.bazaar.Bazaar;
import org.x402.extensions.bazaar.BazaarServerExtension;
import org.x402.spring.X402ResourceServerCustomizer;
import org.x402.spring.autoconfigure.X402AutoConfiguration;

/**
 * Bazaar discovery from YAML: registers the bazaar resource-server extension and turns
 * {@code x402.routes.<offer>.extensions.bazaar} into its declaration.
 */
@AutoConfiguration(after = X402AutoConfiguration.class)
@ConditionalOnClass(Bazaar.class)
@ConditionalOnBean(X402ResourceServer.class)
public class X402BazaarAutoConfiguration {

  @Bean
  X402ResourceServerCustomizer x402BazaarExtension() {
    return server -> {
      if (!server.hasExtension(Bazaar.KEY)) {
        server.registerExtension(new BazaarServerExtension());
      }
    };
  }

  @Bean
  @ConditionalOnMissingBean
  BazaarDeclarations x402BazaarDeclarations() {
    return new BazaarDeclarations();
  }
}
