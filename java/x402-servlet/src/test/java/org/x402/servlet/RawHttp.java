package org.x402.servlet;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Sends a request line exactly as written (HTTP clients normalize or refuse dot segments and
 * matrix parameters) and returns the whole response. From #4129's test support.
 */
final class RawHttp {

  private RawHttp() {}

  /**
   * A response: status and the raw text (status line, headers, body).
   *
   * @param status the status code
   * @param text the response as received
   */
  record Response(int status, String text) {

    /** The first value of a header, or {@code null}. */
    String header(String name) {
      String head = text.split("\r\n\r\n", 2)[0];
      for (String line : head.split("\r\n")) {
        int colon = line.indexOf(':');
        if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase(name)) {
          return line.substring(colon + 1).trim();
        }
      }
      return null;
    }

    /** Everything after the header block. */
    String body() {
      String[] parts = text.split("\r\n\r\n", 2);
      return parts.length < 2 ? "" : parts[1];
    }
  }

  static Response send(int port, String method, String path, String... headerLines) {
    try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
      socket.setSoTimeout(15_000);
      StringBuilder request = new StringBuilder(method).append(' ').append(path)
          .append(" HTTP/1.1\r\nHost: 127.0.0.1:").append(port).append("\r\n");
      for (String line : headerLines) {
        request.append(line).append("\r\n");
      }
      request.append("Connection: close\r\n\r\n");
      socket.getOutputStream().write(request.toString().getBytes(StandardCharsets.ISO_8859_1));
      socket.getOutputStream().flush();
      String text = new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      String[] statusLine = text.split("\r\n", 2)[0].split(" ");
      if (statusLine.length < 2) {
        throw new IllegalStateException("no status line for " + path + ": " + text);
      }
      return new Response(Integer.parseInt(statusLine[1]), text);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
