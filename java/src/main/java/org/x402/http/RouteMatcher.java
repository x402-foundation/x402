package org.x402.http;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Compiles route patterns and finds the route protecting a request, mirroring {@code parseRoutePattern} and
 * {@code getRouteConfig} in {@code go/http/server.go}.
 *
 * <p>A pattern is {@code "VERB /path"} or a bare {@code "/path"}, which matches every method except
 * {@code OPTIONS} so that CORS preflight requests are never charged. {@code HEAD} falls back to {@code GET}
 * routes. In the path, {@code *} matches any characters, a trailing {@code /*} also matches the bare prefix,
 * and {@code [name]} or {@code :name} matches one non-empty segment. Matching is case-sensitive.
 *
 * <p>A request path is matched in every view produced by {@link PathNormalizer}: the escaped and the decoded
 * path, each normalized and canonicalized. In each view, routes are tried in the iteration order of the map
 * they were compiled from and the first match wins. Views that match no route are ignored, so
 * {@code /premium;jsessionid=1} still matches {@code GET /premium}. The result is
 * {@linkplain Match#ambiguous() ambiguous} when views match different routes, because frameworks dispatch on
 * different views.
 *
 * <p>Instances are immutable and thread-safe.
 */
final class RouteMatcher {

    private static final String ANY_METHOD = "*";
    private static final String OPTIONS = "OPTIONS";
    private static final String HEAD = "HEAD";
    private static final String GET = "GET";
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final Pattern METHOD = Pattern.compile("[A-Za-z]+");

    private final List<Route> routes;

    /**
     * Compiles routes.
     *
     * @param routes route configurations keyed by pattern, in precedence order
     * @throws IllegalArgumentException if a pattern is malformed
     */
    RouteMatcher(Map<String, RouteConfig> routes) {
        List<Route> compiled = new ArrayList<>(routes.size());
        routes.forEach((pattern, config) -> compiled.add(compile(pattern, config)));
        this.routes = List.copyOf(compiled);
    }

    /**
     * Returns the compiled routes in precedence order.
     *
     * @return the routes
     */
    List<Route> routes() {
        return routes;
    }

    /**
     * Finds the routes that the views of a request path match.
     *
     * @param method the HTTP method, in any case
     * @param escapedPath the path as sent on the wire, still percent-encoded
     * @param decodedPath the framework's decoded routing path, or {@code null} when unavailable
     * @return the distinct routes matched by any view
     */
    Match match(String method, String escapedPath, String decodedPath) {
        String upperMethod = method.toUpperCase(Locale.ROOT);
        List<Route> matched = new ArrayList<>(1);
        for (String candidate : candidates(escapedPath, decodedPath)) {
            match(upperMethod, candidate).filter(route -> !matched.contains(route)).ifPresent(matched::add);
        }
        return new Match(matched);
    }

    private Optional<Route> match(String upperMethod, String path) {
        for (Route route : routes) {
            if (route.verbMatches(upperMethod) && route.matchesPath(path)) {
                return Optional.of(route);
            }
        }
        if (HEAD.equals(upperMethod)) {
            for (Route route : routes) {
                if (GET.equals(route.verb()) && route.matchesPath(path)) {
                    return Optional.of(route);
                }
            }
        }
        return Optional.empty();
    }

    private static Set<String> candidates(String escapedPath, String decodedPath) {
        Set<String> candidates = new LinkedHashSet<>();
        candidates.add(PathNormalizer.normalize(escapedPath));
        candidates.add(PathNormalizer.canonicalize(escapedPath));
        if (decodedPath != null && !decodedPath.isEmpty() && !decodedPath.equals(escapedPath)) {
            candidates.add(PathNormalizer.normalizeDecoded(decodedPath));
            candidates.add(PathNormalizer.canonicalizeDecoded(decodedPath));
        }
        return candidates;
    }

    /**
     * Compiles one route pattern.
     *
     * @param pattern {@code "VERB /path"} or {@code "/path"}
     * @param config the route configuration
     * @return the compiled route
     * @throws IllegalArgumentException if the pattern is blank, has more than two parts or an invalid method
     */
    static Route compile(String pattern, RouteConfig config) {
        Objects.requireNonNull(pattern, "pattern");
        Objects.requireNonNull(config, "config");
        String trimmed = pattern.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("Route pattern must not be blank");
        }
        String[] parts = WHITESPACE.split(trimmed);
        if (parts.length > 2) {
            throw new IllegalArgumentException("Route pattern must be \"VERB /path\" or \"/path\": " + pattern);
        }
        String verb = ANY_METHOD;
        String path = parts[0];
        if (parts.length == 2) {
            if (!METHOD.matcher(parts[0]).matches()) {
                throw new IllegalArgumentException("Invalid HTTP method in route pattern: " + pattern);
            }
            verb = parts[0].toUpperCase(Locale.ROOT);
            path = parts[1];
        }
        return new Route(pattern, verb, path, toRegex(path), config);
    }

    /**
     * Translates a route path into a regular expression. Literal text is quoted; the DOTALL flag lets wildcards
     * match a percent-decoded line feed.
     */
    private static Pattern toRegex(String path) {
        boolean trailingWildcard = path.endsWith("/*");
        String body = trailingWildcard ? path.substring(0, path.length() - 2) : path;
        StringBuilder regex = new StringBuilder();
        StringBuilder literal = new StringBuilder();
        int i = 0;
        while (i < body.length()) {
            char c = body.charAt(i);
            int paramEnd = parameterEnd(body, i);
            if (c == '*') {
                appendLiteral(regex, literal);
                regex.append(".*?");
                i++;
            } else if (paramEnd > i) {
                appendLiteral(regex, literal);
                regex.append("[^/]+");
                i = paramEnd;
            } else {
                literal.append(c);
                i++;
            }
        }
        appendLiteral(regex, literal);
        if (trailingWildcard) {
            regex.append("(?:/.*?)?");
        }
        return Pattern.compile(regex.toString(), Pattern.DOTALL);
    }

    /** Returns the index after a {@code [name]} or {@code :name} parameter starting at {@code start}, or -1. */
    private static int parameterEnd(String body, int start) {
        char c = body.charAt(start);
        if (c == '[') {
            int close = body.indexOf(']', start + 1);
            return close > start + 1 ? close + 1 : -1;
        }
        if (c == ':' && start + 1 < body.length() && isIdentifierStart(body.charAt(start + 1))) {
            int end = start + 2;
            while (end < body.length() && isIdentifierPart(body.charAt(end))) {
                end++;
            }
            return end;
        }
        return -1;
    }

    private static boolean isIdentifierStart(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
    }

    private static boolean isIdentifierPart(char c) {
        return isIdentifierStart(c) || (c >= '0' && c <= '9');
    }

    private static void appendLiteral(StringBuilder regex, StringBuilder literal) {
        if (literal.length() > 0) {
            regex.append(Pattern.quote(literal.toString()));
            literal.setLength(0);
        }
    }

    /**
     * The routes matched by the views of one request path.
     *
     * @param routes the distinct matching routes, in the order the views found them; empty when none matches
     */
    record Match(List<Route> routes) {

        Match {
            routes = List.copyOf(routes);
        }

        /** Returns the route every matching view agrees on; empty when no view matches or the views disagree. */
        Optional<Route> route() {
            return routes.size() == 1 ? Optional.of(routes.get(0)) : Optional.empty();
        }

        /** Returns whether the views match different routes, so which one applies depends on the dispatcher. */
        boolean ambiguous() {
            return routes.size() > 1;
        }
    }

    /**
     * A compiled route.
     *
     * @param pattern the pattern as configured, e.g. {@code "GET /weather/:city"}
     * @param verb the upper-case method, or {@code *} for any method except {@code OPTIONS}
     * @param path the path part of the pattern
     * @param regex the compiled path expression, matched against the whole normalized path
     * @param config the route configuration
     */
    record Route(String pattern, String verb, String path, Pattern regex, RouteConfig config) {

        boolean verbMatches(String upperMethod) {
            return verb.equals(upperMethod) || (ANY_METHOD.equals(verb) && !OPTIONS.equals(upperMethod));
        }

        boolean matchesPath(String normalizedPath) {
            return regex.matcher(normalizedPath).matches();
        }
    }
}
