package org.x402.examples.facilitator;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.x402.core.hooks.HookResults;
import org.x402.core.types.PaymentRequirements;
import org.x402.spring.facilitator.X402FacilitatorCustomizer;

/**
 * Every verify and settle lifecycle hook, each logging one line. Replace the log lines with your
 * own code: metrics, audit records, alerting, or a decision (a before-hook may {@code abort}, a
 * failure hook may return a recovered result).
 */
@Configuration
class LifecycleHooks {

  private static final Logger LOG = LoggerFactory.getLogger(LifecycleHooks.class);

  @Bean
  X402FacilitatorCustomizer lifecycleLogging() {
    return facilitator -> facilitator
        .onBeforeVerify(ctx -> {
          LOG.info("before verify: {}", describe(ctx.requirements()));
          // Your code here, e.g. rate limiting; return Decision.abort("reason") to refuse.
          return HookResults.Decision.proceed();
        })
        .onAfterVerify(ctx -> {
          LOG.info("after verify: {} valid={} reason={}", describe(ctx.requirements()),
              ctx.result().isValid(), ctx.result().invalidReason());
          // Your code here, e.g. record that this payment was verified.
        })
        .onVerifyFailure(ctx -> {
          LOG.warn("verify failed: {} error={}", describe(ctx.requirements()),
              ctx.error().getMessage());
          // Your code here; return Recovery.recovered(response) to answer instead of failing.
          return HookResults.Recovery.none();
        })
        .onBeforeSettle(ctx -> {
          LOG.info("before settle: {}", describe(ctx.requirements()));
          // Your code here, e.g. require an earlier verify; return Decision.abort(...) to refuse.
          return HookResults.Decision.proceed();
        })
        .onAfterSettle(ctx -> {
          LOG.info("after settle: {} success={} transaction={}", describe(ctx.requirements()),
              ctx.result().success(), ctx.result().transaction());
          // Your code here, e.g. book the payment or notify the seller.
        })
        .onSettleFailure(ctx -> {
          LOG.warn("settle failed: {} error={}", describe(ctx.requirements()),
              ctx.error().getMessage());
          // Your code here; return Recovery.recovered(response) to answer instead of failing.
          return HookResults.Recovery.none();
        });
  }

  /** Network, payee and amount; the payload is not logged, it carries the signed transaction. */
  private static String describe(PaymentRequirements requirements) {
    return requirements.network() + " pay " + requirements.amount() + " " + requirements.asset()
        + " to " + requirements.payTo();
  }
}
