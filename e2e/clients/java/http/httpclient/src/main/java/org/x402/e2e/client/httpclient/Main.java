package org.x402.e2e.client.httpclient;

import org.x402.e2e.client.E2eClient;

/** e2e client that pays with {@link org.x402.http.X402HttpClient} on the JDK's {@code java.net.http}. */
public final class Main {

    private Main() {
    }

    public static void main(String[] args) {
        E2eClient.run();
    }
}
