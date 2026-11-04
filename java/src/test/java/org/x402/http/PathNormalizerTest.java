package org.x402.http;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.junit.jupiter.api.Assertions.assertEquals;

class PathNormalizerTest {

    /** Vectors from {@code TestNormalizePath} in {@code go/http/server_test.go}. */
    @ParameterizedTest(name = "{0} -> {1}")
    @CsvSource(delimiter = '|', value = {
        "/api|/api",
        "/api/|/api",
        "/api//users|/api/users",
        "/api?query=1|/api",
        "/api#fragment|/api",
        "/api%20space|/api space",
        "''|/",
        "/api/users/x%2Fy|/api/users/x%2Fy",
        "/api/users/x%2fy|/api/users/x%2Fy",
        "/api/users/x%5Cy|/api/users/x%5Cy",
        "/api/users/x%252Fy|/api/users/x%2Fy",
        "/api/users/x%zzy|/api/users/x%zzy",
    })
    void normalizes(String input, String expected) {
        assertEquals(expected, PathNormalizer.normalize(input));
    }

    @ParameterizedTest(name = "{0} -> {1}")
    @CsvSource(delimiter = '|', value = {
        "/%70remium|/premium",
        "/caf%C3%A9|/café",
        "/x%2|/x%2",
        "/x%|/x%",
        "/x%4G|/x%4G",
        "/x%٣٣|/x%٣٣",
        "/raw\\slash|/raw%5Cslash",
        "/public/../premium|/public/../premium",
        "/premium;jsessionid=1|/premium;jsessionid=1",
    })
    void decodesOnlyWellFormedAsciiEscapesAndKeepsDotSegments(String input, String expected) {
        assertEquals(expected, PathNormalizer.normalize(input));
    }

    @Test
    void decodesAnEncodedLineFeedInsideItsSegment() {
        assertEquals("/a\nb", PathNormalizer.normalize("/a%0Ab"));
        assertEquals("/a\nb", PathNormalizer.canonicalize("/a%0Ab"));
    }

    /** Vectors from {@code TestNormalizeDecodedPath} in {@code go/http/server_test.go}. */
    @ParameterizedTest(name = "{0} -> {1}")
    @CsvSource(delimiter = '|', value = {
        "/api|/api",
        "/api/|/api",
        "/api//users|/api/users",
        "/api?query=1|/api",
        "/api#fragment|/api",
        "''|/",
        "/api/x%41|/api/x%41",
        "/api/premium|/api/premium",
    })
    void normalizesDecodedPaths(String input, String expected) {
        assertEquals(expected, PathNormalizer.normalizeDecoded(input));
    }

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
        "/a/b/..%2F..%2Fpremium|/a/b/..%2F..%2Fpremium",
        "/api/users/x%2Fy|/api/users/x%2Fy",
        "/..|/",
        "''|/",
    })
    void canonicalizesLikeAServletContainer(String input, String expected) {
        assertEquals(expected, PathNormalizer.canonicalize(input));
    }

    @ParameterizedTest(name = "{0} -> {1}")
    @CsvSource(delimiter = '|', value = {
        "/public/../premium|/premium",
        "/public//./premium/|/public/premium",
        "/api/x%2e%2e|/api/x%2e%2e",
        "/../premium|/premium",
    })
    void canonicalizesDecodedPathsWithoutDecodingAgain(String input, String expected) {
        assertEquals(expected, PathNormalizer.canonicalizeDecoded(input));
    }
}
