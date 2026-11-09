package org.x402.servlet;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.Fixtures;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.http.HeaderCodec;
import org.x402.http.PatternRouteResolver;
import org.x402.http.PaymentOption;
import org.x402.http.RouteConfig;
import org.x402.http.X402Headers;
import org.x402.http.X402HttpResourceServer;

/** Resource servers, routes, servlets and payments for the filter's tests. */
final class TestServers {

  private TestServers() {}

  static PaymentOption option(String price) {
    return PaymentOption.builder().scheme("exact").network(Fixtures.PREPROD)
        .payTo(Fixtures.PAY_TO).price(price).build();
  }

  static RouteConfig route(String price) {
    return RouteConfig.builder().accepts(List.of(option(price))).build();
  }

  /** An HTTP resource server on fakes; cancellations are recorded in {@code cancels}. */
  static X402HttpResourceServer http(FakeServerScheme scheme, FakeFacilitatorClient facilitator,
      Map<String, RouteConfig> routes, List<VerifiedPaymentCanceledContext> cancels) {
    X402ResourceServer core = X402ResourceServer.builder()
        .facilitators(List.of(facilitator)).build();
    core.register(Fixtures.PREPROD, scheme);
    core.onVerifiedPaymentCanceled(cancels::add);
    return new X402HttpResourceServer(core, new PatternRouteResolver(routes));
  }

  /** The {@code PAYMENT-SIGNATURE} header line that pays the first option of a 402. */
  static String paymentFor(RawHttp.Response unpaid) {
    PaymentRequired required = HeaderCodec.decodePaymentRequired(
        unpaid.header(X402Headers.PAYMENT_REQUIRED));
    PaymentRequirements accepted = required.accepts().get(0);
    PaymentPayload payload = new PaymentPayload(2, required.resource(), accepted,
        Map.of("signature", "sig"), null);
    return X402Headers.PAYMENT_SIGNATURE + ": " + HeaderCodec.encodePaymentSignature(payload);
  }

  /** A servlet body. */
  @FunctionalInterface
  interface Handler {
    void handle(HttpServletRequest request, HttpServletResponse response)
        throws IOException, ServletException;
  }

  /** A servlet that runs {@code handler} for every method. */
  static HttpServlet servlet(Handler handler) {
    return new HttpServlet() {
      private static final long serialVersionUID = 1L;

      @Override
      protected void service(HttpServletRequest request, HttpServletResponse response)
          throws IOException, ServletException {
        handler.handle(request, response);
      }
    };
  }

  /** A servlet that writes {@code text}. */
  static HttpServlet text(String text) {
    return servlet((request, response) -> {
      response.setContentType("text/plain");
      response.getWriter().print(text);
    });
  }
}
