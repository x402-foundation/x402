package org.x402;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * CAIP-2 network identifier helpers.
 *
 * <p>A network is written {@code namespace:reference}, e.g. {@code "eip155:84532"}. A pattern whose
 * reference is {@code *}, e.g. {@code "eip155:*"}, matches every network in that namespace.
 */
public final class Network {

    private static final Pattern CAIP2 = Pattern.compile("^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$");
    private static final String WILDCARD = "*";

    private Network() {
    }

    /**
     * Returns whether {@code network} is a concrete CAIP-2 identifier.
     *
     * @param network the identifier to check
     * @return {@code true} if it is well formed
     */
    public static boolean isValid(String network) {
        return network != null && CAIP2.matcher(network).matches();
    }

    /**
     * Returns whether two identifiers match, treating a {@code namespace:*} wildcard on either side as
     * matching every network in its namespace.
     *
     * @param a a network or wildcard pattern
     * @param b a network or wildcard pattern
     * @return {@code true} if they match
     */
    public static boolean matches(String a, String b) {
        Objects.requireNonNull(a, "a");
        Objects.requireNonNull(b, "b");
        if (a.equals(b)) {
            return true;
        }
        return isWildcardFor(a, b) || isWildcardFor(b, a);
    }

    /**
     * Returns the namespace of a network, e.g. {@code "eip155"} for {@code "eip155:84532"}.
     *
     * @param network the network
     * @return the namespace
     * @throws IllegalArgumentException if {@code network} has no {@code :} separator
     */
    public static String namespace(String network) {
        int separator = Objects.requireNonNull(network, "network").indexOf(':');
        if (separator <= 0) {
            throw new IllegalArgumentException("Not a CAIP-2 network: " + network);
        }
        return network.substring(0, separator);
    }

    /**
     * Returns the reference of a network, e.g. {@code "84532"} for {@code "eip155:84532"}.
     *
     * @param network the network
     * @return the reference
     * @throws IllegalArgumentException if {@code network} has no {@code :} separator
     */
    public static String reference(String network) {
        return network.substring(namespace(network).length() + 1);
    }

    /**
     * Returns the wildcard pattern covering a network's namespace, e.g. {@code "eip155:*"}.
     *
     * @param network the network
     * @return the wildcard pattern
     */
    public static String family(String network) {
        return namespace(network) + ":" + WILDCARD;
    }

    private static boolean isWildcardFor(String pattern, String network) {
        int separator = pattern.indexOf(':');
        return separator > 0
                && pattern.endsWith(":" + WILDCARD)
                && network.startsWith(pattern.substring(0, separator + 1));
    }
}
