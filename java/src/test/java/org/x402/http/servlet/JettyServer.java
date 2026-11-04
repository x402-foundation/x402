package org.x402.http.servlet;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServlet;
import org.eclipse.jetty.http.UriCompliance;
import org.eclipse.jetty.server.HttpConfiguration;
import org.eclipse.jetty.server.HttpConnectionFactory;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.eclipse.jetty.servlet.FilterHolder;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.servlet.ServletHolder;

import java.util.EnumSet;

/**
 * Embedded Jetty 11 (WireMock's transitive dependency) for servlet integration tests.
 *
 * <p>It listens on {@value #HOST} only. On macOS a wildcard bind can be given a port that another process holds on
 * the loopback address, which then receives the test's connections.
 */
final class JettyServer implements AutoCloseable {

    /** The loopback address the server listens on; clients must connect to it, not to {@code localhost}. */
    static final String HOST = "127.0.0.1";

    private final Server server;
    private final ServletContextHandler context;
    private final ServerConnector connector;

    JettyServer(UriCompliance uriCompliance) {
        server = new Server();
        HttpConfiguration config = new HttpConfiguration();
        config.setUriCompliance(uriCompliance);
        config.setSendServerVersion(false);
        connector = new ServerConnector(server, new HttpConnectionFactory(config));
        connector.setHost(HOST);
        connector.setPort(0);
        server.addConnector(connector);
        context = new ServletContextHandler();
        context.setContextPath("/");
        server.setHandler(context);
    }

    JettyServer filter(Filter filter, DispatcherType... dispatches) {
        FilterHolder holder = new FilterHolder(filter);
        holder.setAsyncSupported(true);
        EnumSet<DispatcherType> types = dispatches.length == 0
                ? EnumSet.of(DispatcherType.REQUEST)
                : EnumSet.of(dispatches[0], dispatches);
        context.addFilter(holder, "/*", types);
        return this;
    }

    JettyServer servlet(String pathSpec, HttpServlet servlet) {
        ServletHolder holder = new ServletHolder(servlet);
        holder.setAsyncSupported(true);
        context.addServlet(holder, pathSpec);
        return this;
    }

    JettyServer start() throws Exception {
        server.start();
        return this;
    }

    int port() {
        return connector.getLocalPort();
    }

    String url(String path) {
        return "http://" + HOST + ":" + port() + path;
    }

    @Override
    public void close() {
        try {
            server.stop();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while stopping Jetty", e);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot stop Jetty", e);
        }
    }
}
