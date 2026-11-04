package org.x402.mechanisms.evm.exact;

import org.x402.mechanisms.evm.EvmConstants;

import java.util.Map;

/**
 * Keys of {@code PaymentRequirements.extra} read and written by the exact EVM client and server schemes.
 *
 * <p>This class is stateless and thread-safe.
 */
final class ExactEvmExtra {

    /** EIP-712 domain name of the token, e.g. {@code "USD Coin"}. */
    static final String NAME = "name";

    /** EIP-712 domain version of the token, e.g. {@code "2"}. */
    static final String VERSION = "version";

    /** How the token is transferred; absent means EIP-3009. */
    static final String ASSET_TRANSFER_METHOD = "assetTransferMethod";

    private ExactEvmExtra() {
    }

    /**
     * Returns {@code extra}, or an empty map when it is {@code null}.
     *
     * @param extra the requirements' extra data, possibly {@code null}
     * @return a non-null map
     */
    static Map<String, Object> orEmpty(Map<String, Object> extra) {
        return extra == null ? Map.of() : extra;
    }

    /**
     * Returns a string member of {@code extra}. A value of another type counts as absent.
     *
     * @param extra the requirements' extra data, possibly {@code null}
     * @param key the member name
     * @return the string value, or {@code null} if the member is absent or not a string
     */
    static String string(Map<String, Object> extra, String key) {
        return orEmpty(extra).get(key) instanceof String value ? value : null;
    }

    /**
     * Returns whether {@code extra} selects EIP-3009 {@code transferWithAuthorization}, the only transfer method
     * this SDK implements. That is the case when {@code assetTransferMethod} is absent, {@code null}, empty (the
     * reference SDKs treat an empty method as the default) or {@code "eip3009"}.
     *
     * @param extra the requirements' extra data, possibly {@code null}
     * @return {@code false} for {@code "permit2"}, any other method name and any non-string value
     */
    static boolean usesEip3009(Map<String, Object> extra) {
        Object method = orEmpty(extra).get(ASSET_TRANSFER_METHOD);
        return method == null || "".equals(method) || EvmConstants.ASSET_TRANSFER_METHOD_EIP3009.equals(method);
    }

    /**
     * Returns the {@code assetTransferMethod} member for use in error messages.
     *
     * @param extra the requirements' extra data, possibly {@code null}
     * @return the member's value, or {@code null}
     */
    static Object assetTransferMethod(Map<String, Object> extra) {
        return orEmpty(extra).get(ASSET_TRANSFER_METHOD);
    }
}
