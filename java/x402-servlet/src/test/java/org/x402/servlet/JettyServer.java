package org.x402.servlet;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServlet;
import java.util.EnumSet;
import org.eclipse.jetty.ee10.servlet.FilterHolder;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.http.UriCompliance;
import org.eclipse.jetty.server.HttpConfiguration;
import org.eclipse.jetty.server.HttpConnectionFactory;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;

/** An embedded Jetty 12 (ee10) on 127.0.0.1 and a free port, for the filter's tests. */
final class JettyServer implements AutoCloseable {

  private final Server server = new Server();
  private final ServerConnector connector;
  private final ServletContextHandler context = new ServletContextHandler();

  JettyServer(UriCompliance compliance) {
    this(compliance, "/");
  }

  JettyServer(UriCompliance compliance, String contextPath) {
    HttpConfiguration config = new HttpConfiguration();
    config.setUriCompliance(compliance);
    connector = new ServerConnector(server, new HttpConnectionFactory(config));
    connector.setHost("127.0.0.1");
    connector.setPort(0);
    server.addConnector(connector);
    context.setContextPath(contextPath);
    if (compliance != UriCompliance.DEFAULT) {
      // Lenient modes: let the servlet layer decode what the connector let through.
      context.getServletHandler().setDecodeAmbiguousURIs(true);
    }
    server.setHandler(context);
  }

  /** Adds an async-supported servlet, so only the filter's own guard refuses async. */
  JettyServer servlet(String pathSpec, HttpServlet servlet) {
    ServletHolder holder = new ServletHolder(servlet);
    holder.setAsyncSupported(true);
    context.addServlet(holder, pathSpec);
    return this;
  }

  /** Maps the filter as documented: async-supported, REQUEST and FORWARD dispatches. */
  JettyServer filter(Filter filter) {
    FilterHolder holder = new FilterHolder(filter);
    holder.setAsyncSupported(true);
    context.addFilter(holder, "/*", EnumSet.of(DispatcherType.REQUEST, DispatcherType.FORWARD));
    return this;
  }

  JettyServer start() throws Exception {
    server.start();
    return this;
  }

  int port() {
    return connector.getLocalPort();
  }

  @Override
  public void close() throws Exception {
    server.stop();
  }
}
