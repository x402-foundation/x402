package org.x402.mechanisms.evm;

import java.math.BigInteger;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * CAIP-2 identifiers of EVM networks, written {@code eip155:<chainId>}, e.g. {@code "eip155:8453"} for Base.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class EvmNetworks {

    /** CAIP-2 namespace of EVM networks. */
    public static final String NAMESPACE = "eip155";

    /** Wildcard pattern matching every EVM network, used to register a scheme for all of them. */
    public static final String FAMILY = NAMESPACE + ":*";

    /** A positive decimal chain id without leading zeros; CAIP-2 caps the reference at 32 characters. */
    private static final Pattern EVM_NETWORK = Pattern.compile("eip155:[1-9][0-9]{0,31}");

    private EvmNetworks() {
    }

    /**
     * Returns the EIP-155 chain id of an EVM network, e.g. {@code 84532} for {@code "eip155:84532"}.
     *
     * @param network the CAIP-2 network
     * @return the chain id, always positive
     * @throws IllegalArgumentException if {@code network} is not {@code eip155:} followed by a positive decimal
     *     chain id without leading zeros
     */
    public static BigInteger chainId(String network) {
        Objects.requireNonNull(network, "network");
        if (!EVM_NETWORK.matcher(network).matches()) {
            throw new IllegalArgumentException(
                    "Unsupported network: " + network + " (expected eip155:<chainId>, e.g. eip155:8453)");
        }
        return new BigInteger(network.substring(NAMESPACE.length() + 1));
    }
}
