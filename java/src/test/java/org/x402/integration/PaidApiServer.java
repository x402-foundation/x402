package org.x402.integration;

import org.x402.Price;
import org.x402.X402Facilitator;
import org.x402.X402ResourceServer;
import org.x402.http.HttpResourceServer;
import org.x402.http.PaymentHeaders;
import org.x402.http.PaymentOption;
import org.x402.http.RouteConfig;
import org.x402.http.servlet.PaymentFilter;
import org.x402.mechanisms.evm.exact.ExactEvmFacilitatorScheme;
import org.x402.mechanisms.evm.exact.ExactEvmServerScheme;
import org.x402.mechanisms.evm.rpc.FacilitatorEvmSigner;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.eclipse.jetty.servlet.FilterHolder;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.servlet.ServletHolder;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A paid API in embedded Jetty 11 on 127.0.0.1, wired as a merchant would: {@link PaymentFilter} over
 * {@link HttpResourceServer} and {@link X402ResourceServer} with {@link ExactEvmServerScheme}, settling through an
 * in-process {@link X402Facilitator} with {@link ExactEvmFacilitatorScheme} on the given chain. {@code GET /premium}
 * costs {@code $0.001} on Base Sepolia, paid to {@code payTo}, and answers {@link #BODY}.
 */
final class PaidApiServer {

    static final String NETWORK = "eip155:84532";
    static final String BODY = "{\"report\":\"premium\"}";

    private static final String PATH = "/premium";

    private final Server jetty;
    private final ServerConnector connector;
    private final AtomicInteger handled;

    private PaidApiServer(Server jetty, ServerConnector connector, AtomicInteger handled) {
        this.jetty = jetty;
        this.connector = connector;
        this.handled = handled;
    }

    static PaidApiServer start(FacilitatorEvmSigner chain, String payTo) throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(NETWORK), new ExactEvmFacilitatorScheme(chain))
                .build();
        X402ResourceServer resourceServer = X402ResourceServer.builder()
                .register(NETWORK, new ExactEvmServerScheme())
                .facilitator(facilitator)
                .build();
        PaymentOption option = PaymentOption.builder()
                .scheme("exact").network(NETWORK).payTo(payTo).price(Price.money("$0.001")).build();
        HttpResourceServer payments = new HttpResourceServer(resourceServer,
                Map.of("GET " + PATH, RouteConfig.builder().accept(option).mimeType("application/json").build()));
        payments.initialize();

        AtomicInteger handled = new AtomicInteger();
        Server jetty = new Server();
        ServerConnector connector = new ServerConnector(jetty);
        connector.setHost("127.0.0.1");
        connector.setPort(0);
        jetty.addConnector(connector);
        ServletContextHandler context = new ServletContextHandler();
        context.setContextPath("/");
        context.addFilter(new FilterHolder(new PaymentFilter(payments)), "/*", EnumSet.of(DispatcherType.REQUEST));
        context.addServlet(new ServletHolder(new HttpServlet() {
            private static final long serialVersionUID = 1L;

            @Override
            protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
                handled.incrementAndGet();
                response.setContentType("application/json");
                response.getWriter().print(BODY);
            }
        }), PATH);
        jetty.setHandler(context);
        jetty.start();
        return new PaidApiServer(jetty, connector, handled);
    }

    /** Returns how many requests reached the protected handler. */
    int handled() {
        return handled.get();
    }

    HttpRequest request() {
        return HttpRequest.newBuilder(uri()).GET().build();
    }

    HttpRequest request(String paymentSignature) {
        return HttpRequest.newBuilder(uri()).header(PaymentHeaders.PAYMENT_SIGNATURE, paymentSignature).GET().build();
    }

    private URI uri() {
        return URI.create("http://127.0.0.1:" + connector.getLocalPort() + PATH);
    }

    void close() throws Exception {
        jetty.stop();
    }
}
