package org.x402.http;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.regex.Pattern;

/**
 * Normalizes request paths before they are matched against route patterns.
 *
 * <p>Route matching is a security boundary: if the router dispatches a request to a protected handler but the
 * normalized path does not match the protecting route, the payment gate is bypassed (CWE-436). Two families of
 * views are produced and the caller matches every one of them, so a route cannot be bypassed through any
 * representation:
 *
 * <ul>
 *   <li>{@link #normalize} and {@link #normalizeDecoded} mirror {@code normalizePath} and
 *       {@code normalizeDecodedPath} in {@code go/http/server.go} exactly.</li>
 *   <li>{@link #canonicalize} and {@link #canonicalizeDecoded} additionally strip {@code ;} path parameters and
 *       resolve {@code .} and {@code ..} segments after percent-decoding, the way servlet containers do before
 *       dispatching, since they may dispatch {@code /public/..;/premium} or {@code /public/%2e%2e/premium} to
 *       {@code /premium}.</li>
 * </ul>
 *
 * <p>Percent-escapes are decoded one segment at a time and a decoded {@code /} or {@code \} is re-escaped as
 * {@code %2F} or {@code %5C}, so a decoded byte never creates a segment boundary the router did not see. A
 * segment with a malformed escape is kept raw.
 */
final class PathNormalizer {

    private static final Pattern MULTIPLE_SLASHES = Pattern.compile("/+");
    private static final String PARENT = "..";
    private static final String CURRENT = ".";

    private PathNormalizer() {
    }

    /**
     * Normalizes an escaped request path: strips the query and fragment, percent-decodes each segment, collapses
     * repeated slashes, removes a trailing slash and maps the empty path to {@code /}.
     *
     * @param escapedPath the path as sent on the wire, e.g. {@code /api/users/x%2Fy}
     * @return the normalized path, e.g. {@code /api/users/x%2Fy}
     */
    static String normalize(String escapedPath) {
        String[] segments = stripQueryAndFragment(escapedPath).split("/", -1);
        for (int i = 0; i < segments.length; i++) {
            segments[i] = decodeSegment(segments[i]);
        }
        return finish(String.join("/", segments));
    }

    /**
     * Normalizes a path the framework already decoded: no percent-decoding, otherwise the same steps as
     * {@link #normalize}.
     *
     * @param decodedPath the framework's decoded routing path
     * @return the normalized path
     */
    static String normalizeDecoded(String decodedPath) {
        return finish(stripQueryAndFragment(decodedPath));
    }

    /**
     * Canonicalizes an escaped request path the way servlet containers do before dispatch: strips the query
     * and fragment, removes {@code ;} parameters from each raw segment, percent-decodes each segment, drops
     * empty and {@code .} segments and resolves {@code ..} against the previous segment, never above the root.
     *
     * @param escapedPath the path as sent on the wire, e.g. {@code /public/%2e%2e/premium}
     * @return the canonical path, e.g. {@code /premium}
     */
    static String canonicalize(String escapedPath) {
        String[] segments = stripQueryAndFragment(escapedPath).split("/", -1);
        for (int i = 0; i < segments.length; i++) {
            segments[i] = decodeSegment(stripParameters(segments[i]));
        }
        return resolveDotSegments(segments);
    }

    /**
     * Canonicalizes a path the framework already decoded: drops empty and {@code .} segments and resolves
     * {@code ..}, without percent-decoding.
     *
     * @param decodedPath the framework's decoded routing path
     * @return the canonical path
     */
    static String canonicalizeDecoded(String decodedPath) {
        return resolveDotSegments(stripQueryAndFragment(decodedPath).split("/", -1));
    }

    private static String finish(String path) {
        String collapsed = MULTIPLE_SLASHES.matcher(path).replaceAll("/");
        if (collapsed.endsWith("/")) {
            collapsed = collapsed.substring(0, collapsed.length() - 1);
        }
        return collapsed.isEmpty() ? "/" : collapsed;
    }

    private static String resolveDotSegments(String[] segments) {
        Deque<String> resolved = new ArrayDeque<>();
        for (String segment : segments) {
            if (segment.isEmpty() || CURRENT.equals(segment)) {
                continue;
            }
            if (PARENT.equals(segment)) {
                resolved.pollLast();
            } else {
                resolved.addLast(segment);
            }
        }
        return "/" + String.join("/", resolved);
    }

    private static String stripQueryAndFragment(String path) {
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c == '?' || c == '#') {
                return path.substring(0, i);
            }
        }
        return path;
    }

    private static String stripParameters(String segment) {
        int semicolon = segment.indexOf(';');
        return semicolon < 0 ? segment : segment.substring(0, semicolon);
    }

    /**
     * Percent-decodes one segment and re-escapes separators it yields.
     * Returns the raw segment unchanged when an escape is malformed.
     */
    private static String decodeSegment(String segment) {
        String decoded = percentDecode(segment);
        if (decoded == null) {
            return segment;
        }
        return decoded.replace("/", "%2F").replace("\\", "%5C");
    }

    private static String percentDecode(String segment) {
        if (segment.indexOf('%') < 0) {
            return segment;
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(segment.length());
        int i = 0;
        while (i < segment.length()) {
            char c = segment.charAt(i);
            if (c == '%') {
                if (i + 2 >= segment.length()) {
                    return null;
                }
                int high = hexValue(segment.charAt(i + 1));
                int low = hexValue(segment.charAt(i + 2));
                if (high < 0 || low < 0) {
                    return null;
                }
                bytes.write((high << 4) | low);
                i += 3;
            } else {
                int end = i + 1;
                while (end < segment.length() && segment.charAt(end) != '%') {
                    end++;
                }
                bytes.writeBytes(segment.substring(i, end).getBytes(StandardCharsets.UTF_8));
                i = end;
            }
        }
        return bytes.toString(StandardCharsets.UTF_8);
    }

    /** Returns the value of an ASCII hex digit, or {@code -1}. Unlike {@link Character#digit}, rejects non-ASCII. */
    private static int hexValue(char c) {
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
}
