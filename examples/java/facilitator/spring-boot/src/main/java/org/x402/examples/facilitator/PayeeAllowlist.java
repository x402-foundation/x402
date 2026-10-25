package org.x402.examples.facilitator;

import java.util.List;
import java.util.function.Predicate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.x402.core.hooks.HookResults;
import org.x402.spring.facilitator.X402FacilitatorCustomizer;

/**
 * Optional policy: verify and settle only payments to your own sellers. Active when {@code
 * example.allowed-pay-to} lists addresses (comma-separated). The check runs on {@code /verify}
 * and on {@code /settle}, because a caller can settle without verifying first.
 *
 * <p>For Masumi options the {@code payTo} is the escrow address of the deployment. The canonical
 * deployment's escrow address is shared by every Masumi seller, so listing it admits all of them;
 * telling sellers apart would need a hook that reads the seller from the escrow datum.
 */
@Configuration
class PayeeAllowlist {

  @Bean
  @ConditionalOnProperty("example.allowed-pay-to")
  X402FacilitatorCustomizer onlyOurSellers(
      @Value("${example.allowed-pay-to}") List<String> allowedPayTo) {
    Predicate<String> allowed = allowedPayTo::contains;
    return facilitator -> facilitator
        .onBeforeVerify(ctx -> allowed.test(ctx.requirements().payTo())
            ? HookResults.Decision.proceed()
            : HookResults.Decision.abort("payee_not_allowed"))
        .onBeforeSettle(ctx -> allowed.test(ctx.requirements().payTo())
            ? HookResults.Decision.proceed()
            : HookResults.Decision.abort("payee_not_allowed"));
  }
}
