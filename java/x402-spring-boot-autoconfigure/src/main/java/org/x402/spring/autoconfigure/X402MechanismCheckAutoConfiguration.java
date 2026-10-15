package org.x402.spring.autoconfigure;

import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/**
 * Runs {@link X402MechanismCheck} at startup, whatever else is enabled: a configured mechanism
 * whose module is missing fails the application instead of leaving it half-working.
 */
@AutoConfiguration
public class X402MechanismCheckAutoConfiguration {

  /**
   * The check, as a bean factory post-processor: it runs before any bean is created, so no other
   * configuration can fail first on the missing classes and hide its message.
   *
   * @param environment the application's environment
   * @return the post-processor
   */
  @Bean
  static BeanFactoryPostProcessor x402MechanismCheck(Environment environment) {
    return beanFactory -> X402MechanismCheck.check(environment,
        beanFactory.getBeanClassLoader());
  }
}
