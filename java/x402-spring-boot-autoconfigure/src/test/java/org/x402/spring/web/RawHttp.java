package org.x402.spring.web;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Sends a request line exactly as written. HTTP clients normalize or refuse dot segments and
 * matrix parameters, which are the point of the path-hardening tests.
 */
public final class RawHttp {

  private RawHttp() {}

  /**
   * Sends {@code method path} and returns the status code.
   *
   * @param port the server port on 127.0.0.1
   * @param method the method
   * @param path the request target, sent unchanged
   * @return the status code
   */
  public static int status(int port, String method, String path) {
    try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
      socket.setSoTimeout(10_000);
      OutputStream out = socket.getOutputStream();
      out.write((method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + port
          + "\r\nAccept: application/json\r\nConnection: close\r\n\r\n")
          .getBytes(StandardCharsets.US_ASCII));
      out.flush();
      InputStream in = socket.getInputStream();
      StringBuilder line = new StringBuilder();
      int c;
      while ((c = in.read()) != -1 && c != '\n') {
        line.append((char) c);
      }
      String[] parts = line.toString().trim().split(" ");
      if (parts.length < 2) {
        throw new IllegalStateException("no status line for " + path + ": " + line);
      }
      return Integer.parseInt(parts[1]);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
