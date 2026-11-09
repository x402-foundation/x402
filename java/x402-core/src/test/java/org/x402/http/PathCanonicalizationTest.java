package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * {@link RoutePattern#canonicalPath} and {@link RoutePattern#canonicalDecodedPath} resolve paths
 * the way servlet containers do before dispatching. Vectors from #4129's {@code PathNormalizerTest}
 * (Stefano Amorelli).
 */
class PathCanonicalizationTest {

  @ParameterizedTest(name = "{0} -> {1}")
  @CsvSource(delimiter = '|', value = {
      "/public/../premium|/premium",
      "/public/./../premium|/premium",
      "/./premium|/premium",
      "/../../premium|/premium",
      "/public/%2e%2e/premium|/premium",
      "/public/%2E%2E/premium|/premium",
      "/public/.%2e/premium|/premium",
      "/public/%2e/../premium|/premium",
      "/public/..;/premium|/premium",
      "/premium;jsessionid=abc|/premium",
      "/pre;x=1/mium;y|/pre/mium",
      "/premium%3Bx|/premium;x",
      "//premium|/premium",
      "/premium/|/premium",
      "/premium?a=/../x|/premium",
      "/premium#/../x|/premium",
      "/a/b/..%2F..%2Fpremium|/a/b/..%2F..%2Fpremium",
      "/api/users/x%2Fy|/api/users/x%2Fy",
      "/api/users/x%5Cy|/api/users/x%5Cy",
      "/raw\\slash|/raw%5Cslash",
      "/x%zzy|/x%zzy",
      "/caf%C3%A9|/café",
      "/..|/",
      "''|/",
  })
  void canonicalizesLikeAServletContainer(String input, String expected) {
    assertThat(RoutePattern.canonicalPath(input)).isEqualTo(expected);
  }

  @Test
  void decodesAnEncodedLineFeedInsideItsSegment() {
    assertThat(RoutePattern.canonicalPath("/a%0Ab")).isEqualTo("/a\nb");
  }

  @ParameterizedTest(name = "{0} -> {1}")
  @CsvSource(delimiter = '|', value = {
      "/public/../premium|/premium",
      "/public//./premium/|/public/premium",
      "/api/x%2e%2e|/api/x%2e%2e",
      "/../premium|/premium",
      "/premium?x=1|/premium",
      "''|/",
  })
  void canonicalizesDecodedPathsWithoutDecodingAgain(String input, String expected) {
    assertThat(RoutePattern.canonicalDecodedPath(input)).isEqualTo(expected);
  }

  @Test
  void theTsPinnedNormalizationIsUnchanged() {
    assertThat(RoutePattern.normalizePath("/public/../premium")).isEqualTo("/public/../premium");
    assertThat(RoutePattern.normalizePath("/premium;jsessionid=1"))
        .isEqualTo("/premium;jsessionid=1");
  }
}
