package org.x402.spring.autoconfigure;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.x402.core.client.X402Client;
import org.x402.http.HostPolicy;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.HookRecorder;

/** The client beans of the core auto-configuration: user beans win, spend caps can be lifted. */
class ClientBeansEdgeTest {

  private static FakeFacilitator facilitator;

  @BeforeAll
  static void start() {
    facilitator = FakeFacilitator.start(HookRecorder.NET);
  }

  @AfterAll
  static void stop() {
    facilitator.close();
  }

  private static WebApplicationContextRunner runner() {
    return new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class,
            X402WebMvcAutoConfiguration.class))
        .withBean(HookRecorder.class)
        .withPropertyValues(
            "x402.facilitators[0].url=" + facilitator.url(),
            "x402.accounts.net.network=test:net",
            "x402.accounts.net.pay-to=addr_net",
            "x402.client.enabled=true");
  }

  @Test
  void aUserHostPolicyBeanWinsWhateverItIsNamed() {
    HostPolicy own = HostPolicy.of(java.util.List.of("own.example.com"));
    runner().withBean("myPolicy", HostPolicy.class, () -> own).run(ctx -> {
      assertThat(ctx).hasNotFailed();
      assertThat(ctx.getBeansOfType(HostPolicy.class)).hasSize(1);
      assertThat(ctx.getBean(HostPolicy.class)).isSameAs(own);
    });
  }

  @Test
  void maxAmountPerPaymentFalseMeansNoCap() {
    runner().withPropertyValues("x402.client.spend-controls.max-amount-per-payment=false")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean(X402Client.class).spendControls().maxAmountPerPayment())
              .isNull();
        });
    runner().run(ctx -> assertThat(ctx.getBean(X402Client.class).spendControls()
        .maxAmountPerPayment()).isEqualTo("$1"));
  }
}
