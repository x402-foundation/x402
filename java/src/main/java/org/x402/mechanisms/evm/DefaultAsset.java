package org.x402.mechanisms.evm;

import java.util.Objects;

/**
 * A USD-pegged token a network uses for money prices such as {@code "$0.01"} and for client spend caps.
 *
 * <p>See {@link DefaultAssets} for the table of entries.
 *
 * @param address the token contract address, EIP-55 checksummed
 * @param name the token's EIP-712 domain name, e.g. {@code "USD Coin"}; not always the display name
 * @param version the token's EIP-712 domain version, e.g. {@code "2"}
 * @param decimals the token's decimals, e.g. 6 for USDC
 * @param symbol the ticker used to select the asset in a money price, e.g. {@code "USDC"}
 * @param assetTransferMethod how the token is transferred: {@code ""} for the default EIP-3009
 *     {@code transferWithAuthorization}, or {@link EvmConstants#ASSET_TRANSFER_METHOD_PERMIT2}
 * @param supportsEip2612 whether a Permit2 token also implements EIP-2612 {@code permit}; always {@code false}
 *     for EIP-3009 tokens
 */
public record DefaultAsset(
        String address,
        String name,
        String version,
        int decimals,
        String symbol,
        String assetTransferMethod,
        boolean supportsEip2612) {

    /**
     * Creates a default asset.
     *
     * @throws IllegalArgumentException if {@code address} is not an EVM address or {@code decimals} is out of
     *     the {@code uint8} range
     */
    public DefaultAsset {
        Objects.requireNonNull(address, "address");
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(version, "version");
        Objects.requireNonNull(symbol, "symbol");
        Objects.requireNonNull(assetTransferMethod, "assetTransferMethod");
        if (!EvmAddress.isValid(address)) {
            throw new IllegalArgumentException("Asset address is not an EVM address");
        }
        if (decimals < 0 || decimals > TokenAmounts.MAX_DECIMALS) {
            throw new IllegalArgumentException("Decimals must be between 0 and " + TokenAmounts.MAX_DECIMALS);
        }
    }

    /**
     * Returns whether the token is paid with EIP-3009 {@code transferWithAuthorization}, the only transfer method
     * this SDK implements.
     *
     * @return {@code true} if {@link #assetTransferMethod()} is empty or {@code "eip3009"}
     */
    public boolean isEip3009() {
        return assetTransferMethod.isEmpty() || EvmConstants.ASSET_TRANSFER_METHOD_EIP3009.equals(assetTransferMethod);
    }
}
