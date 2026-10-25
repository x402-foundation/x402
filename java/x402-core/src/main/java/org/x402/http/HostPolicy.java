package org.x402.http;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;

/**
 * Which hosts may trigger an automatic payment (a Java safeguard shared with the
 * Spring {@code x402.client.hosts} allowlist). Entries are exact hosts ({@code api.example.com})
 * or subdomain wildcards ({@code *.example.com}, which does not match the apex). Matching is
 * case-insensitive on the host only; ports are ignored. An empty policy allows nothing.
 */
public final class HostPolicy {

  private final List<String> patterns;
  private final List<String> exact = new ArrayList<>();
  private final List<String> suffixes = new ArrayList<>();

  private HostPolicy(List<String> patterns) {
    this.patterns = List.copyOf(patterns);
    for (String p : patterns) {
      String lower = p.strip().toLowerCase(Locale.ROOT);
      if (lower.startsWith("*.")) {
        String domain = lower.substring(2);
        validate(p, domain);
        suffixes.add("." + domain);
      } else {
        validate(p, lower);
        exact.add(lower);
      }
    }
  }

  private static void validate(String original, String host) {
    if (host.isEmpty() || host.contains("*") || host.contains(":") || host.contains("/")) {
      throw new IllegalArgumentException("Invalid host pattern \"" + original
          + "\": use an exact host (api.example.com) or *.domain (*.example.com), no port");
    }
  }

  /**
   * Creates a policy.
   *
   * @param patterns exact hosts or {@code *.domain} wildcards
   * @return the policy
   * @throws IllegalArgumentException for a malformed pattern
   */
  public static HostPolicy of(Collection<String> patterns) {
    return new HostPolicy(new ArrayList<>(patterns));
  }

  /**
   * The patterns as given.
   *
   * @return the patterns
   */
  public List<String> patterns() {
    return patterns;
  }

  /**
   * Whether a host may be paid.
   *
   * @param host the host, may be {@code null}
   * @return {@code true} when allowed
   */
  public boolean allows(String host) {
    if (host == null || host.isEmpty()) {
      return false;
    }
    String lower = host.toLowerCase(Locale.ROOT);
    if (exact.contains(lower)) {
      return true;
    }
    for (String suffix : suffixes) {
      if (lower.endsWith(suffix) && lower.length() > suffix.length()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether a URI's host may be paid.
   *
   * @param uri the URI
   * @return {@code true} when allowed
   */
  public boolean allows(URI uri) {
    return uri != null && allows(uri.getHost());
  }

  @Override
  public String toString() {
    return "HostPolicy" + patterns;
  }
}
