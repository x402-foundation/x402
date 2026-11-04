package org.x402.e2e.server.jetty;

import org.x402.e2e.server.Catalog;
import org.x402.e2e.server.CatalogRoute;
import org.x402.e2e.server.Handlers;
import org.x402.e2e.server.ResolvedRoute;
import org.x402.e2e.server.Routes;
import org.x402.e2e.server.ServerConfig;
import org.x402.http.HttpResourceServer;
import org.x402.http.servlet.PaymentFilter;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.eclipse.jetty.ee10.servlet.FilterHolder;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;

import java.io.IOException;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * e2e resource server on embedded Jetty 12 (ee10). Paid routes come from the mechanisms catalog and are charged
 * for by the SDK's {@link PaymentFilter}; see {@link Catalog}.
 */
public final class Main {

    private static final String TITLE = "x402 Jetty E2E Test Server";
    private static final long CLOSE_DELAY_MILLIS = 100;

    private Main() {
    }

    public static void main(String[] args) {
        try {
            start(System.getenv());
        } catch (Exception e) {
            System.err.println("Failed to start server: " + e.getMessage());
            System.exit(1);
        }
    }

    private static void start(Map<String, String> env) throws Exception {
        Catalog catalog = Catalog.load(env);
        ServerConfig config = ServerConfig.fromEnv(env, catalog);
        List<ResolvedRoute> routes = catalog.resolvedRoutes();
        HttpResourceServer payments = new HttpResourceServer(config.resourceServer(routes), Routes.build(routes));
        // Fails here, before the server listens, if the facilitator is down or does not support a route.
        payments.initialize();

        Server server = new Server(config.port());
        server.setHandler(context(catalog, config, routes, payments));
        server.setStopAtShutdown(true);
        server.start();
        System.out.println(Handlers.startupBanner(TITLE, "http://localhost:" + config.port(), config, routes));
        server.join();
    }

    private static ServletContextHandler context(
            Catalog catalog, ServerConfig config, List<ResolvedRoute> routes, HttpResourceServer payments) {
        ServletContextHandler context = new ServletContextHandler();
        context.addFilter(new FilterHolder(new PaymentFilter(payments)), "/*",
                EnumSet.of(DispatcherType.REQUEST, DispatcherType.FORWARD));
        for (CatalogRoute route : catalog.routes()) {
            JsonServlet handler = config.payees().containsKey(route.networkId())
                    ? new JsonServlet(HttpServletResponse.SC_OK, Handlers::routeBody)
                    : new JsonServlet(HttpServletResponse.SC_NOT_IMPLEMENTED, () -> Handlers.unconfiguredBody(route));
            context.addServlet(new ServletHolder(handler), route.path());
        }
        context.addServlet(new ServletHolder(
                new JsonServlet(HttpServletResponse.SC_OK, () -> Handlers.healthBody(routes))), Handlers.HEALTH_PATH);
        context.addServlet(new ServletHolder(new CloseServlet()), Handlers.CLOSE_PATH);
        return context;
    }

    private static void write(HttpServletResponse response, int status, Object body) throws IOException {
        byte[] bytes = Handlers.json(body);
        response.setStatus(status);
        response.setContentType("application/json");
        response.setContentLength(bytes.length);
        response.getOutputStream().write(bytes);
    }

    /** Answers GET with a fixed status and a JSON body built for each request. */
    private static final class JsonServlet extends HttpServlet {

        private final int status;
        private final transient Supplier<Map<String, Object>> body;

        JsonServlet(int status, Supplier<Map<String, Object>> body) {
            this.status = status;
            this.body = body;
        }

        @Override
        protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
            write(response, status, body.get());
        }
    }

    /** Answers {@code POST /close}, then exits the JVM once the response has been sent. */
    private static final class CloseServlet extends HttpServlet {

        @Override
        protected void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
            write(response, HttpServletResponse.SC_OK, Handlers.closeBody());
            response.flushBuffer();
            System.out.println("Received shutdown request");
            new Thread(CloseServlet::exitShortly, "close").start();
        }

        private static void exitShortly() {
            try {
                Thread.sleep(CLOSE_DELAY_MILLIS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            System.exit(0);
        }
    }
}
