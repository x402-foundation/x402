package org.x402;

import java.util.Objects;
import java.util.regex.Pattern;

/** Validation of the network patterns accepted by client-side registrations and spend controls. */
final class NetworkPatterns {

    private static final Pattern WILDCARD = Pattern.compile("^[-a-z0-9]{3,8}:\\*$");

    private NetworkPatterns() {
    }

    /**
     * Returns {@code value} after checking it is a concrete CAIP-2 network or a {@code namespace:*} wildcard.
     *
     * @param value the candidate pattern
     * @param name the parameter name used in error messages
     * @return {@code value}
     * @throws IllegalArgumentException if {@code value} is neither CAIP-2 nor a {@code namespace:*} wildcard
     */
    static String require(String value, String name) {
        Objects.requireNonNull(value, name);
        if (!Network.isValid(value) && !WILDCARD.matcher(value).matches()) {
            throw new IllegalArgumentException(
                    name + " must be a CAIP-2 network such as \"eip155:8453\" or a wildcard such as \"eip155:*\": "
                            + value);
        }
        return value;
    }
}
