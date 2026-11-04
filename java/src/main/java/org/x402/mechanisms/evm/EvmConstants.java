package org.x402.mechanisms.evm;

import java.util.List;

/** Protocol constants shared by the EVM schemes. */
public final class EvmConstants {

    /** Scheme id of the exact payment scheme. */
    public static final String SCHEME_EXACT = "exact";

    /**
     * Value of {@code extra.assetTransferMethod} for EIP-3009 {@code transferWithAuthorization}, the default when
     * the key is absent and the only method this SDK implements.
     */
    public static final String ASSET_TRANSFER_METHOD_EIP3009 = "eip3009";

    /** Value of {@code extra.assetTransferMethod} for Permit2 transfers, which this SDK does not implement. */
    public static final String ASSET_TRANSFER_METHOD_PERMIT2 = "permit2";

    /** EIP-712 primary type signed for an EIP-3009 transfer. */
    public static final String TRANSFER_WITH_AUTHORIZATION = "TransferWithAuthorization";

    /**
     * Fields of the EIP-3009 {@code TransferWithAuthorization} struct, in declaration order. Its type hash is
     * {@code 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267}.
     */
    public static final List<TypedDataField> TRANSFER_WITH_AUTHORIZATION_FIELDS = List.of(
            new TypedDataField("from", "address"),
            new TypedDataField("to", "address"),
            new TypedDataField("value", "uint256"),
            new TypedDataField("validAfter", "uint256"),
            new TypedDataField("validBefore", "uint256"),
            new TypedDataField("nonce", "bytes32"));

    private EvmConstants() {
    }
}
