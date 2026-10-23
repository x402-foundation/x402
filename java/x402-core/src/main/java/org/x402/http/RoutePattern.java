package org.x402.http;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * An x402 route pattern, an optional verb ({@code "GET /x"}; none or {@code *}
 * matches any), {@code *} wildcards, {@code :param} and {@code [param]} segments, and a trailing
 * {@code /*} that also matches the bare prefix. Matching is case-insensitive and {@code .} matches
 * line breaks.
 */
public final class RoutePattern {

  private static final Pattern ESCAPE = Pattern.compile("[$()+.?^{|}]");
  private static final Pattern BRACKET_PARAM = Pattern.compile("\\[([^\\]]+)\\]");
  private static final Pattern COLON_PARAM = Pattern.compile(":([a-zA-Z_][a-zA-Z0-9_]*)");
  private static final Pattern QUERY = Pattern.compile("[?#]");
  private static final Pattern SLASHES = Pattern.compile("/+");
  private static final Pattern TRAILING = Pattern.compile("(.+?)/+\\z");

  private final String verb;
  private final String path;
  private final Pattern regex;

  private RoutePattern(String verb, String path, Pattern regex) {
    this.verb = verb;
    this.path = path;
    this.regex = regex;
  }

  /**
   * Parses a pattern such as {@code "GET /items/:id"} or {@code "/api/*"}.
   *
   * @param pattern the pattern
   * @return the parsed pattern
   */
  public static RoutePattern parse(String pattern) {
    Objects.requireNonNull(pattern, "pattern");
    String verb = "*";
    String path = pattern;
    if (pattern.contains(" ")) {
      String[] parts = pattern.split("\\s+", -1);
      verb = parts[0];
      path = parts.length > 1 ? parts[1] : "";
    }
    boolean trailingWildcard = path.endsWith("/*");
    String body = trailingWildcard ? path.substring(0, path.length() - 2) : path;
    body = body.replace("\\", "\\\\");
    body = ESCAPE.matcher(body).replaceAll(m -> Matcher.quoteReplacement("\\" + m.group()));
    body = body.replace("*", ".*?");
    body = BRACKET_PARAM.matcher(body).replaceAll(Matcher.quoteReplacement("[^/]+"));
    body = COLON_PARAM.matcher(body).replaceAll(Matcher.quoteReplacement("[^/]+"));
    body = body.replace("/", "\\/");
    if (trailingWildcard) {
      body += "(?:/.*?)?";
    }
    Pattern regex = Pattern.compile("^" + body + "$",
        Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE | Pattern.DOTALL);
    return new RoutePattern(verb.toUpperCase(Locale.ROOT), path, regex);
  }

  /**
   * The upper-case verb, {@code *} for any.
   *
   * @return the verb
   */
  public String verb() {
    return verb;
  }

  /**
   * The path part of the pattern as written.
   *
   * @return the path
   */
  public String path() {
    return path;
  }

  /**
   * Whether a normalized path matches (the verb is not checked).
   *
   * @param normalizedPath a path from {@link #normalizePath} or {@link #normalizeDecodedPath}
   * @return {@code true} on a match
   */
  public boolean matchesNormalized(String normalizedPath) {
    return regex.matcher(normalizedPath).matches();
  }

  /**
   * Whether a method and a normalized path match.
   *
   * @param method the HTTP method
   * @param normalizedPath the normalized path
   * @return {@code true} on a match
   */
  public boolean matches(String method, String normalizedPath) {
    return ("*".equals(verb) || verb.equals(method.toUpperCase(Locale.ROOT)))
        && matchesNormalized(normalizedPath);
  }

  /**
   * Drops query and fragment, percent-decodes each segment (a malformed
   * escape keeps the raw segment) while re-escaping decoded {@code /} and {@code \}, collapses
   * repeated slashes and drops trailing ones.
   *
   * @param path the raw path
   * @return the normalized path
   */
  public static String normalizePath(String path) {
    String withoutQuery = QUERY.split(path, -1)[0];
    String[] segments = withoutQuery.split("/", -1);
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < segments.length; i++) {
      if (i > 0) {
        sb.append('/');
      }
      String decoded = decodeUriComponent(segments[i]);
      sb.append(decoded == null ? segments[i]
          : decoded.replace("/", "%2F").replace("\\", "%5C"));
    }
    return collapse(sb.toString());
  }

  /**
   * Drops query and fragment, collapses repeated slashes and
   * drops trailing ones; never empty.
   *
   * @param path an already decoded path
   * @return the normalized path
   */
  public static String normalizeDecodedPath(String path) {
    String result = collapse(QUERY.split(path, -1)[0]);
    return result.isEmpty() ? "/" : result;
  }

  private static String collapse(String path) {
    String single = SLASHES.matcher(path).replaceAll("/");
    return TRAILING.matcher(single).replaceFirst("$1");
  }

  /**
   * JavaScript {@code decodeURIComponent}: decodes every {@code %XX} as UTF-8 and leaves {@code +}
   * alone.
   *
   * @param segment the segment
   * @return the decoded segment, or {@code null} when the escapes are malformed
   */
  static String decodeUriComponent(String segment) {
    if (segment.indexOf('%') < 0) {
      return segment;
    }
    StringBuilder out = new StringBuilder();
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    int i = 0;
    while (i < segment.length()) {
      char c = segment.charAt(i);
      if (c != '%') {
        if (!flush(bytes, out)) {
          return null;
        }
        out.append(c);
        i++;
        continue;
      }
      if (i + 3 > segment.length()) {
        return null;
      }
      int hi = hex(segment.charAt(i + 1));
      int lo = hex(segment.charAt(i + 2));
      if (hi < 0 || lo < 0) {
        return null;
      }
      bytes.write(hi * 16 + lo);
      i += 3;
    }
    return flush(bytes, out) ? out.toString() : null;
  }

  private static int hex(char c) {
    if (c >= '0' && c <= '9') {
      return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
      return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
      return c - 'A' + 10;
    }
    return -1;
  }

  private static boolean flush(ByteArrayOutputStream bytes, StringBuilder out) {
    if (bytes.size() == 0) {
      return true;
    }
    try {
      out.append(StandardCharsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes.toByteArray())));
      bytes.reset();
      return true;
    } catch (CharacterCodingException e) {
      return false;
    }
  }

  @Override
  public String toString() {
    return verb + " " + path;
  }
}
