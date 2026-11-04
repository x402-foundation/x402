package org.x402.http;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RouteMatcherTest {

    private static RouteConfig config(String description) {
        return new RouteConfig(List.of(), null, description, null, null);
    }

    private static RouteMatcher matcher(String pattern) {
        return new RouteMatcher(Map.of(pattern, config(pattern)));
    }

    private static boolean matches(String pattern, String method, String escapedPath) {
        return matcher(pattern).match(method, escapedPath, null).route().isPresent();
    }

    private static RouteMatcher tiered(String... patterns) {
        Map<String, RouteConfig> routes = new LinkedHashMap<>();
        for (String pattern : patterns) {
            routes.put(pattern, config(pattern));
        }
        return new RouteMatcher(routes);
    }

    private static List<String> matchedPatterns(RouteMatcher.Match match) {
        return match.routes().stream().map(RouteMatcher.Route::pattern).toList();
    }

    /** Cases from {@code TestParseRoutePattern} in {@code go/http/server_test.go}. */
    @ParameterizedTest(name = "{0} matches {3}")
    @CsvSource(delimiter = '|', value = {
        "GET /api|GET|/api|/api",
        "POST /api/*|POST|/api/*|/api/users",
        "/public|*|/public|/public",
        "*|*|*|/anything",
        "GET /api/[id]|GET|/api/[id]|/api/123",
        "GET /api/users/:userId|GET|/api/users/:userId|/api/users/456",
        "GET /api/users/:userId/posts/:postId|GET|/api/users/:userId/posts/:postId|/api/users/42/posts/7",
        "/api/:version/items|*|/api/:version/items|/api/v2/items",
    })
    void compilesPatterns(String pattern, String verb, String path, String request) {
        RouteMatcher.Route route = RouteMatcher.compile(pattern, config(pattern));

        assertEquals(verb, route.verb());
        assertEquals(path, route.path());
        assertTrue(route.matchesPath(PathNormalizer.normalize(request)));
    }

    /** Cases from {@code TestRouteMatching_PathNormalizationBypass} in {@code go/http/server_test.go}. */
    @ParameterizedTest(name = "{0} vs {1} -> {2}")
    @CsvSource(delimiter = '|', value = {
        "GET /api/users/:id|/api/users/1|true",
        "GET /api/users/:id|/api/users/x%2Fy|true",
        "GET /api/users/:id|/api/users/x%2fy|true",
        "GET /api/users/:id|/api/users/x%252Fy|true",
        "GET /api/users/:id|/api/users/x%5Cy|true",
        "GET /api/users/:id|/api/users/x%25y|true",
        "GET /api/users/[id]|/api/users/x%2Fy|true",
        "GET /api/users/:id|/api/users/x/y|false",
        "GET /api/premium/*|/api/premium/abc|true",
        "GET /api/premium/*|/api/premium/|true",
        "GET /api/premium/*|/api/premium|true",
        "GET /api/premium/*|/api/premium/a/b/c|true",
        "GET /api/premium/*|/api/premium/a%0Ab|true",
        "GET /api/premium/*|/api/premium/report%0A|true",
        "GET /api/premium/*|/api/premium/a%0A/b|true",
        "GET /api/premium/*|/api/premium/a%0Db|true",
        "GET /api/users/:id|/api/users/x%0Ay|true",
        "GET /api/premium/*|/api/premiumx|false",
        "GET /api/premium/*|/api/other|false",
        "GET /api/compute|/api/compute|true",
        "GET /api/compute|/api/compute/|true",
        "GET /api/compute|/api/computex|false",
    })
    void resistsPathNormalizationBypasses(String pattern, String escapedPath, boolean expected) {
        assertEquals(expected, matches(pattern, "GET", escapedPath));
    }

    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', value = {
        "/public/../premium",
        "/public/%2e%2e/premium",
        "/public/%2E%2e/premium",
        "/public/.%2e/premium",
        "/public/..;/premium",
        "/premium;jsessionid=1",
        "/premium;a=b/",
        "//premium",
        "///premium//",
        "/./premium",
        "/%70remium",
        "/premium?free=true",
        "/premium#fragment",
        "/x/y/../../premium",
    })
    void requiresPaymentForEveryPathAServletContainerDispatchesToTheRoute(String escapedPath) {
        assertTrue(matches("GET /premium", "GET", escapedPath), escapedPath);
    }

    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', value = {
        "/Premium",
        "/PREMIUM",
        "/premium.json",
        "/premiumx",
        "/premium%3Bx",
        "/premium%2Fx",
        "/public/premium",
    })
    void doesNotMatchDifferentResources(String escapedPath) {
        assertFalse(matches("GET /premium", "GET", escapedPath), escapedPath);
    }

    @Test
    void matchesTheDecodedPathTheFrameworkRoutedOn() {
        RouteMatcher matcher = matcher("GET /api/premium");

        for (String escaped : List.of("/api%2Fpremium", "/api%2fpremium", "/%61pi%2Fpremium")) {
            assertTrue(matcher.match("GET", escaped, "/api/premium").route().isPresent(), escaped);
            assertFalse(matcher.match("GET", escaped, null).route().isPresent(), escaped);
        }
        assertTrue(matcher.match("GET", "/public/report", "/public/report").routes().isEmpty());
        assertTrue(matcher("GET /api/users/:id").match("GET", "/api/users/x/y", "/api/users/x/y").routes().isEmpty());
        assertTrue(matcher.match("GET", "/other", "/api/./premium/").route().isPresent());
    }

    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', value = {
        "/api/public/../secret|/api/public/*|/api/*",
        "/api/public/x/../../secret|/api/public/*|/api/*",
        "/api/public/%2e%2e/secret|/api/public/*|/api/*",
        "/api/public/..;/secret|/api/public/*|/api/*",
    })
    void reportsAFreeCarveOutAndAPaidRouteMatchedByDifferentViewsAsAmbiguous(
            String escapedPath, String freeRoute, String paidRoute) {
        RouteMatcher.Match match = tiered(freeRoute, paidRoute).match("GET", escapedPath, null);

        assertTrue(match.ambiguous(), escapedPath);
        assertTrue(match.route().isEmpty());
        assertEquals(List.of(freeRoute, paidRoute), matchedPatterns(match));
    }

    @Test
    void reportsACheapAndAPremiumRouteMatchedByDifferentViewsAsAmbiguous() {
        RouteMatcher matcher = tiered("GET /api/cheap/*", "GET /api/premium");

        assertTrue(matcher.match("GET", "/api/cheap/../premium", null).ambiguous());
        assertTrue(matcher.match("HEAD", "/api/cheap/../premium", null).ambiguous());
        assertTrue(matcher.match("GET", "/api/cheap/x", "/api/premium").ambiguous());
        // A framework that routes on the raw path, such as Spring's PathPattern, serves the premium handler here.
        assertTrue(tiered("GET /api/cheap/*", "GET /api/premium/*")
                .match("GET", "/api/premium/../cheap/x", "/api/premium/../cheap/x").ambiguous());
    }

    @Test
    void choosesTheRouteEveryMatchingViewAgreesOn() {
        RouteMatcher matcher = tiered("/api/public/*", "/api/*");

        assertEquals("/api/public/*", matcher.match("GET", "/api/public/x", null).route().orElseThrow().pattern());
        assertEquals("/api/*", matcher.match("GET", "/api/secret", null).route().orElseThrow().pattern());
        assertEquals("/api/*", matcher.match("GET", "/api/x/../secret", null).route().orElseThrow().pattern());
        assertEquals("/api/public/*",
                matcher.match("GET", "/api/public/a/../b", "/api/public/b").route().orElseThrow().pattern());
        assertFalse(matcher.match("GET", "/api/x/../secret", null).ambiguous());
    }

    @Test
    void ignoresViewsThatMatchNoRoute() {
        RouteMatcher matcher = tiered("GET /premium");

        RouteMatcher.Match match = matcher.match("GET", "/premium;jsessionid=1", null);

        assertFalse(match.ambiguous());
        assertEquals("GET /premium", match.route().orElseThrow().pattern());
    }

    @Test
    void failsClosedWhenAPathParameterHidesTheRouteFromTheRawView() {
        RouteMatcher matcher = tiered("GET /premium", "GET /*");

        assertEquals(List.of("GET /*", "GET /premium"),
                matchedPatterns(matcher.match("GET", "/premium;jsessionid=1", null)));
    }

    @Test
    void headFallsBackToGetButNotToOtherMethods() {
        assertTrue(matches("GET /api/premium", "HEAD", "/api/premium"));
        assertFalse(matches("POST /api/premium", "HEAD", "/api/premium"));

        Map<String, RouteConfig> routes = new LinkedHashMap<>();
        routes.put("GET /api/premium", config("GET route"));
        routes.put("HEAD /api/premium", config("HEAD route"));
        Optional<RouteMatcher.Route> head = new RouteMatcher(routes).match("HEAD", "/api/premium", null).route();
        assertEquals("HEAD route", head.orElseThrow().config().description());
    }

    @Test
    void methodlessRoutesNeverGateCorsPreflight() {
        assertFalse(matches("/api/premium", "OPTIONS", "/api/premium"));
        assertTrue(matches("/api/premium", "GET", "/api/premium"));
        assertTrue(matches("/api/premium", "delete", "/api/premium"));
        assertTrue(matches("OPTIONS /api/premium", "OPTIONS", "/api/premium"));
        assertFalse(matches("GET /api/premium", "OPTIONS", "/api/premium"));
    }

    @Test
    void matchesMethodsCaseInsensitively() {
        assertTrue(matches("get /api", "GET", "/api"));
        assertTrue(matches("GET /api", "get", "/api"));
        assertFalse(matches("GET /api", "POST", "/api"));
    }

    @Test
    void firstRouteInIterationOrderWins() {
        Map<String, RouteConfig> routes = new LinkedHashMap<>();
        routes.put("GET /api/special", config("special"));
        routes.put("GET /api/*", config("wildcard"));
        RouteMatcher matcher = new RouteMatcher(routes);

        assertEquals("special",
                matcher.match("GET", "/api/special", null).route().orElseThrow().config().description());
        assertEquals("wildcard",
                matcher.match("GET", "/api/other", null).route().orElseThrow().config().description());
        assertEquals(List.of("GET /api/special", "GET /api/*"),
                matcher.routes().stream().map(RouteMatcher.Route::pattern).toList());
    }

    @Test
    void treatsRegexMetacharactersInPatternsLiterally() {
        assertTrue(matches("GET /v1.0/items+(all)", "GET", "/v1.0/items+(all)"));
        assertFalse(matches("GET /v1.0/items", "GET", "/v1x0/items"));
        assertTrue(matches("GET /a/[]/b", "GET", "/a/[]/b"));
        assertTrue(matches("GET /a/[x", "GET", "/a/[x"));
        assertTrue(matches("GET /time/:", "GET", "/time/:"));
        assertTrue(matches("GET /files/*/raw", "GET", "/files/a/b/raw"));
    }

    @Test
    void rejectsMalformedPatterns() {
        RouteConfig config = config("x");

        assertThrows(IllegalArgumentException.class, () -> RouteMatcher.compile("  ", config));
        assertThrows(IllegalArgumentException.class, () -> RouteMatcher.compile("GET /a extra", config));
        assertThrows(IllegalArgumentException.class, () -> RouteMatcher.compile("G3T /a", config));
    }
}
