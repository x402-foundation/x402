package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Path normalization runs in linear time and returns exactly what the former regexes returned
 * (CodeQL {@code java/polynomial-redos} on {@link RoutePattern}). The oracle is the code before the
 * fix: runs of {@code /} collapsed with {@code replaceAll}, then {@code (.+?)/+\z} removed with
 * {@code replaceFirst}, which backtracks quadratically on a long path without a trailing slash.
 */
class PathNormalizationRedosTest {

  private static final Pattern QUERY = Pattern.compile("[?#]");
  private static final Pattern OLD_SLASHES = Pattern.compile("/+");
  private static final Pattern OLD_TRAILING = Pattern.compile("(.+?)/+\\z");

  /** A path character, the slash, the query cuts and the five line terminators of {@code .}. */
  private static final String[] PATH_TOKENS = {
      "a", "/", "?", "#", "\n", "\r", "\u0085", "\u2028", "\u2029"};

  /**
   * The line terminators next to look-alikes that {@code .} does match: other whitespace, other
   * control characters, the neighbours of U+2028/U+2029, a no-break space, a surrogate pair and a
   * lone high surrogate.
   */
  private static final String[] TERMINATOR_TOKENS = {
      "a", "/", "\n", "\r", "\u0085", "\u2028", "\u2029",
      "\t", "\u000B", "\f", "\u001C", " ", "\u0084", "\u0086", "\u2027", "\u202A", "\u00A0",
      "\uD83D\uDE00", "\uD83D"};

  private static final int MAX_REPORTED = 20;

  @Test
  void longPathsNormalizeInLinearTime() {
    String noTrailingSlash = "/" + "a".repeat(100_000);
    String slashRun = "/" + "/".repeat(100_000) + "a";
    String manySegments = "/" + "a/".repeat(50_000);
    // Only the normalization is timed; the assertions run outside the 2 s budget.
    String[] normalized = assertTimeoutPreemptively(Duration.ofSeconds(2), () -> new String[] {
        RoutePattern.normalizePath(noTrailingSlash),
        RoutePattern.normalizeDecodedPath(noTrailingSlash),
        // Linear before the fix too: guards against a quadratic rewrite, not part of the red proof.
        RoutePattern.normalizePath(slashRun),
        RoutePattern.normalizeDecodedPath(slashRun),
        RoutePattern.normalizePath(manySegments),
        RoutePattern.normalizeDecodedPath(manySegments)});
    String manySegmentsNormalized = "/" + "a/".repeat(49_999) + "a";
    assertThat(normalized).containsExactly(noTrailingSlash, noTrailingSlash, "/a", "/a",
        manySegmentsNormalized, manySegmentsNormalized);
  }

  @Test
  void matchesTheFormerRegexesOnEveryShortPath() {
    Mismatches mismatches = new Mismatches();
    forEachString(PATH_TOKENS, 6, mismatches::check);
    mismatches.assertNone();
  }

  @Test
  void treatsExactlyTheJavaLineTerminatorsAsLineTerminators() {
    Mismatches mismatches = new Mismatches();
    forEachString(TERMINATOR_TOKENS, 4, mismatches::check);
    mismatches.assertNone();
  }

  @Test
  void matchesTheFormerRegexesOnRandomLongerPaths() {
    String[] tokens = Arrays.copyOf(TERMINATOR_TOKENS, TERMINATOR_TOKENS.length + 2);
    tokens[tokens.length - 2] = "?";
    tokens[tokens.length - 1] = "#";
    Random random = new Random(402);
    Mismatches mismatches = new Mismatches();
    for (int n = 0; n < 20_000; n++) {
      int length = 7 + random.nextInt(58);
      StringBuilder path = new StringBuilder();
      for (int i = 0; i < length; i++) {
        path.append(random.nextInt(3) == 0 ? "/" : tokens[random.nextInt(tokens.length)]);
      }
      mismatches.check(path.toString());
    }
    mismatches.assertNone();
  }

  /** The collapse step before the fix. */
  private static String oldCollapse(String path) {
    return OLD_TRAILING.matcher(OLD_SLASHES.matcher(path).replaceAll("/")).replaceFirst("$1");
  }

  /** Every concatenation of up to {@code maxTokens} tokens, the empty string included. */
  private static void forEachString(String[] tokens, int maxTokens, Consumer<String> check) {
    int[] index = new int[maxTokens];
    for (int length = 0; length <= maxTokens; length++) {
      Arrays.fill(index, 0);
      while (true) {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < length; i++) {
          s.append(tokens[index[i]]);
        }
        check.accept(s.toString());
        int k = length - 1;
        while (k >= 0 && ++index[k] == tokens.length) {
          index[k] = 0;
          k--;
        }
        if (k < 0) {
          break;
        }
      }
    }
  }

  private static String visible(String s) {
    StringBuilder out = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c >= 0x20 && c < 0x7f) {
        out.append(c);
      } else {
        out.append(String.format("\\u%04X", (int) c));
      }
    }
    return out.append('"').toString();
  }

  /** Compares both normalizers with the oracle; keeps the first few differences. */
  private static final class Mismatches {

    private final List<String> first = new ArrayList<>();
    private long count;

    /**
     * Without {@code %} and {@code \}, segment decoding in {@code normalizePath} is the identity,
     * so both normalizers reduce to collapsing the path before its query.
     */
    void check(String path) {
      String before = oldCollapse(QUERY.split(path, -1)[0]);
      record("normalizePath", path, RoutePattern.normalizePath(path), before);
      record("normalizeDecodedPath", path, RoutePattern.normalizeDecodedPath(path),
          before.isEmpty() ? "/" : before);
    }

    private void record(String method, String path, String actual, String expected) {
      if (!actual.equals(expected)) {
        count++;
        if (first.size() < MAX_REPORTED) {
          first.add(method + "(" + visible(path) + ") = " + visible(actual) + ", was "
              + visible(expected));
        }
      }
    }

    void assertNone() {
      assertThat(first).as("%d results differ from the former regexes", count).isEmpty();
    }
  }
}
