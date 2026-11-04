package org.x402.mechanisms.evm.exact;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * The scheme payload of an exact EVM payment, {@code PaymentPayload.payload}: an EIP-3009 authorization and the
 * payer's signature over its EIP-712 digest.
 *
 * <pre>{@code
 * Map<String, Object> wire = new ExactEvmPayload(signatureHex, authorization).toMap();
 * ExactEvmPayload parsed = ExactEvmPayload.fromMap(paymentPayload.payload());
 * }</pre>
 *
 * <p>The signature is kept as received: its encoding and validity are checked by the facilitator, which reports
 * a missing signature and a malformed one with different reason codes.
 *
 * @param signature the {@code 0x}-prefixed hex signature, normally 65 bytes {@code r || s || v}, or
 *     {@code null} when absent
 * @param authorization the signed authorization
 */
public record ExactEvmPayload(String signature, Eip3009Authorization authorization) {

    /** Creates a payload. */
    public ExactEvmPayload {
        Objects.requireNonNull(authorization, "authorization");
    }

    /**
     * Reads a payload from its JSON object form, as found in {@code PaymentPayload.payload()}. Unknown keys are
     * ignored.
     *
     * @param map the JSON object, with an {@code authorization} object and an optional {@code signature} string
     * @return the payload
     * @throws IllegalArgumentException if {@code authorization} is missing or malformed, or {@code signature} is
     *     present but not a string
     */
    public static ExactEvmPayload fromMap(Map<String, ?> map) {
        Objects.requireNonNull(map, "map");
        Object signature = map.get("signature");
        if (signature != null && !(signature instanceof String)) {
            throw new IllegalArgumentException("signature must be a string");
        }
        Object authorization = map.get("authorization");
        if (!(authorization instanceof Map<?, ?> members)) {
            throw new IllegalArgumentException(authorization == null
                    ? "authorization is missing"
                    : "authorization must be an object");
        }
        return new ExactEvmPayload((String) signature, Eip3009Authorization.fromMap(stringKeys(members)));
    }

    /**
     * Returns whether a non-empty signature is present.
     *
     * @return {@code false} when the signature is {@code null} or empty
     */
    public boolean hasSignature() {
        return signature != null && !signature.isEmpty();
    }

    /**
     * Returns the JSON object form for {@code PaymentPayload.payload}. {@code signature} is omitted when it is
     * absent or empty.
     *
     * @return an unmodifiable map with {@code signature} (if present) and {@code authorization}
     */
    public Map<String, Object> toMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        if (hasSignature()) {
            map.put("signature", signature);
        }
        map.put("authorization", authorization.toMap());
        return Collections.unmodifiableMap(map);
    }

    @Override
    public String toString() {
        return "ExactEvmPayload[signature=" + (hasSignature() ? "<present>" : "<absent>")
                + ", authorization=" + authorization + "]";
    }

    private static Map<String, Object> stringKeys(Map<?, ?> members) {
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : members.entrySet()) {
            if (entry.getKey() instanceof String key) {
                copy.put(key, entry.getValue());
            }
        }
        return copy;
    }
}
