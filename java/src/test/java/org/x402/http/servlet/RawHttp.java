package org.x402.http.servlet;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Sends a request target byte for byte, without the normalization an HTTP client library may apply, so tests
 * control exactly what the server parses.
 */
final class RawHttp {

    private RawHttp() {
    }

    /**
     * A raw response.
     *
     * @param status the status code
     * @param text the full response text, including headers
     */
    record Response(int status, String text) {
    }

    static Response send(int port, String method, String target, String... headers) throws IOException {
        try (Socket socket = new Socket(JettyServer.HOST, port)) {
            socket.setSoTimeout(10_000);
            OutputStream out = socket.getOutputStream();
            StringBuilder request = new StringBuilder(method).append(' ').append(target)
                    .append(" HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
            for (String header : headers) {
                request.append(header).append("\r\n");
            }
            out.write(request.append("\r\n").toString().getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            InputStream in = socket.getInputStream();
            String text = new String(in.readAllBytes(), StandardCharsets.ISO_8859_1);
            int status = Integer.parseInt(text.substring(9, 12));
            return new Response(status, text);
        }
    }
}
