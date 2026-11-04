package org.x402.mechanisms.evm.exact;

import org.x402.mechanisms.evm.Eip712;
import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.EvmConstants;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.TypedDataDomain;
import org.x402.mechanisms.evm.Uint256;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * The EIP-3009 {@code TransferWithAuthorization} message a payer signs: move {@code value} atomic units of the
 * token from {@code from} to {@code to}, valid strictly after {@code validAfter} and strictly before
 * {@code validBefore}, once per {@code nonce}.
 *
 * <p>Components keep their wire form, strings, so a payload round-trips without re-encoding. The constructor
 * validates that form, so every instance is well formed:
 * <ul>
 *   <li>{@code from} and {@code to}: 40 hex digits, any case, optional {@code 0x}</li>
 *   <li>{@code value}, {@code validAfter}, {@code validBefore}: base-10 {@code uint256}, e.g. {@code "1000"}</li>
 *   <li>{@code nonce}: 32 bytes as 64 hex digits, optional {@code 0x}</li>
 * </ul>
 * Semantic checks, such as whether the value matches the requirements or the window is open, belong to the
 * facilitator.
 *
 * @param from the payer address
 * @param to the recipient address, {@code requirements.payTo}
 * @param value the amount in atomic units
 * @param validAfter the Unix time in seconds after which the authorization is valid
 * @param validBefore the Unix time in seconds before which the authorization is valid
 * @param nonce the unique 32-byte nonce as hex
 */
public record Eip3009Authorization(
        String from, String to, String value, String validAfter, String validBefore, String nonce) {

    private static final int NONCE_LENGTH = 32;

    /**
     * Creates an authorization.
     *
     * @throws IllegalArgumentException if a component is not in its wire form
     */
    public Eip3009Authorization {
        requireAddress(from, "from");
        requireAddress(to, "to");
        requireUint256(value, "value");
        requireUint256(validAfter, "validAfter");
        requireUint256(validBefore, "validBefore");
        Objects.requireNonNull(nonce, "nonce");
        try {
            Hex.decode(nonce, NONCE_LENGTH);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("authorization.nonce must be 32 bytes of hex", e);
        }
    }

    /**
     * Reads an authorization from its JSON object form, e.g. {@code PaymentPayload.payload().get("authorization")}
     * after JSON parsing. Unknown keys are ignored.
     *
     * @param map the JSON object with string members {@code from}, {@code to}, {@code value}, {@code validAfter},
     *     {@code validBefore} and {@code nonce}
     * @return the authorization
     * @throws IllegalArgumentException if a member is missing, not a string, or malformed
     */
    public static Eip3009Authorization fromMap(Map<String, ?> map) {
        Objects.requireNonNull(map, "map");
        return new Eip3009Authorization(
                string(map, "from"),
                string(map, "to"),
                string(map, "value"),
                string(map, "validAfter"),
                string(map, "validBefore"),
                string(map, "nonce"));
    }

    /**
     * Returns the JSON object form, which is also the EIP-712 message signed for this authorization.
     *
     * @return an unmodifiable map of the six members, in declaration order
     */
    public Map<String, Object> toMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("from", from);
        map.put("to", to);
        map.put("value", value);
        map.put("validAfter", validAfter);
        map.put("validBefore", validBefore);
        map.put("nonce", nonce);
        return Collections.unmodifiableMap(map);
    }

    /**
     * Computes the EIP-712 digest of this authorization under a token's domain: the 32 bytes the payer signs and
     * the facilitator recovers the signer from.
     *
     * @param domain the token's domain: {@code extra.name}, {@code extra.version}, the network's chain id and
     *     the token address
     * @return the 32-byte digest
     */
    public byte[] digest(TypedDataDomain domain) {
        return Eip712.hashTypedData(
                domain, EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS, EvmConstants.TRANSFER_WITH_AUTHORIZATION,
                toMap());
    }

    private static String string(Map<String, ?> map, String key) {
        Object value = map.get(key);
        if (value instanceof String text) {
            return text;
        }
        String problem = value == null ? " is missing" : " must be a string";
        throw new IllegalArgumentException("authorization." + key + problem);
    }

    private static void requireAddress(String address, String name) {
        Objects.requireNonNull(address, name);
        if (!EvmAddress.isValid(address)) {
            throw new IllegalArgumentException("authorization." + name + " is not an EVM address");
        }
    }

    private static void requireUint256(String value, String name) {
        Objects.requireNonNull(value, name);
        try {
            Uint256.parse(value);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("authorization." + name + " must be a base-10 uint256", e);
        }
    }
}
