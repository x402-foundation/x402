package org.x402.mechanisms.evm.exact;

/**
 * Machine-readable reason codes of the exact EVM scheme, carried as {@code invalidReason} and
 * {@code errorReason} on the wire.
 *
 * <p>Values are copied verbatim from Go: {@code mechanisms/evm/exact/client/errors.go} ({@code CLIENT_*}),
 * {@code exact/server/errors.go} ({@code SERVER_*}), {@code exact/facilitator/errors.go} (unprefixed) and
 * {@code mechanisms/evm/errors.go}. They are shared by every x402 SDK and must never change. Constant names are
 * Go's names in upper snake case without the {@code Err} prefix, e.g. Go {@code ErrInvalidSignatureS} is
 * {@link #INVALID_SIGNATURE_S}. Codes of the Permit2 and ERC-20 approval flows are omitted because this SDK
 * implements neither.
 */
public final class ExactEvmErrors {

    // Client (exact/client/errors.go)

    /** {@code requirements.amount} is not a base-10 integer. */
    public static final String CLIENT_INVALID_AMOUNT = "invalid_exact_evm_client_amount";

    /** The signer failed to sign the EIP-3009 authorization. */
    public static final String CLIENT_FAILED_TO_SIGN_AUTHORIZATION =
            "invalid_exact_evm_client_failed_to_sign_authorization";

    // Server (exact/server/errors.go)

    /** An {@code AssetAmount} price carried a non-string amount. */
    public static final String SERVER_AMOUNT_MUST_BE_STRING = "invalid_exact_evm_server_amount_must_be_string";

    /** An {@code AssetAmount} price carried no asset address. */
    public static final String SERVER_ASSET_ADDRESS_REQUIRED = "invalid_exact_evm_server_asset_address_required";

    /** Requirements had no asset and the network has no default asset. */
    public static final String SERVER_NO_ASSET_SPECIFIED = "invalid_exact_evm_server_no_asset_specified";

    /** A decimal requirements amount could not be converted to atomic units. */
    public static final String SERVER_FAILED_TO_PARSE_AMOUNT = "invalid_exact_evm_server_failed_to_parse_amount";

    // Facilitator: EIP-3009 verify (exact/facilitator/errors.go)

    /** {@code accepted.scheme} is not {@code exact}. */
    public static final String INVALID_SCHEME = "invalid_exact_evm_scheme";

    /** {@code accepted.network} differs from the requirements' network. */
    public static final String NETWORK_MISMATCH = "invalid_exact_evm_network_mismatch";

    /** The payload is not a well-formed EIP-3009 payload. */
    public static final String INVALID_PAYLOAD = "invalid_exact_evm_payload";

    /** The payload has no signature. */
    public static final String MISSING_SIGNATURE = "invalid_exact_evm_payload_missing_signature";

    /** The network is not an {@code eip155:<chainId>} network. */
    public static final String FAILED_TO_GET_NETWORK_CONFIG = "invalid_exact_evm_failed_to_get_network_config";

    /** {@code requirements.extra} lacks the EIP-712 domain {@code name} or {@code version}. */
    public static final String MISSING_EIP712_DOMAIN = "invalid_exact_evm_missing_eip712_domain";

    /** {@code authorization.to} differs from {@code requirements.payTo}. */
    public static final String RECIPIENT_MISMATCH = "invalid_exact_evm_recipient_mismatch";

    /** {@code authorization.value} is not a valid amount. */
    public static final String INVALID_AUTHORIZATION_VALUE = "invalid_exact_evm_authorization_value";

    /** {@code requirements.amount} is not a valid amount. */
    public static final String INVALID_REQUIRED_AMOUNT = "invalid_exact_evm_required_amount";

    /** {@code authorization.value} differs from {@code requirements.amount}. */
    public static final String AUTHORIZATION_VALUE_MISMATCH = "invalid_exact_evm_payload_authorization_value_mismatch";

    /** The token's {@code authorizationState} could not be read. */
    public static final String FAILED_TO_CHECK_NONCE = "invalid_exact_evm_failed_to_check_nonce";

    /** The authorization nonce was already used onchain. */
    public static final String NONCE_ALREADY_USED = "invalid_exact_evm_nonce_already_used";

    /** The payer's token balance could not be read. */
    public static final String FAILED_TO_GET_BALANCE = "invalid_exact_evm_failed_to_get_balance";

    /** The payer's token balance is below {@code authorization.value}. */
    public static final String INSUFFICIENT_BALANCE = "invalid_exact_evm_insufficient_balance";

    /** The signature is not valid hex. */
    public static final String INVALID_SIGNATURE_FORMAT = "invalid_exact_evm_signature_format";

    /** The signature could not be checked, e.g. the payer's code could not be read. */
    public static final String FAILED_TO_VERIFY_SIGNATURE = "invalid_exact_evm_failed_to_verify_signature";

    /** The signature does not recover to {@code authorization.from}. */
    public static final String INVALID_SIGNATURE = "invalid_exact_evm_signature";

    /** A 65-byte EOA signature has a high {@code s} value (EIP-2 malleability). */
    public static final String INVALID_SIGNATURE_S = "invalid_exact_evm_non_canonical_signature";

    /** {@code authorization.validBefore} is already past, or within the settlement buffer. */
    public static final String VALID_BEFORE_EXPIRED = "invalid_exact_evm_payload_authorization_valid_before";

    /** {@code authorization.validAfter} is in the future. */
    public static final String VALID_AFTER_IN_FUTURE = "invalid_exact_evm_payload_authorization_valid_after";

    /** The EIP-712 domain name in the requirements differs from the token's {@code name()}. */
    public static final String EIP3009_TOKEN_NAME_MISMATCH = "invalid_exact_evm_token_name_mismatch";

    /** The EIP-712 domain version in the requirements differs from the token's {@code version()}. */
    public static final String EIP3009_TOKEN_VERSION_MISMATCH = "invalid_exact_evm_token_version_mismatch";

    /** The token does not implement EIP-3009. */
    public static final String EIP3009_NOT_SUPPORTED = "invalid_exact_evm_eip3009_not_supported";

    /** Simulating {@code transferWithAuthorization} with {@code eth_call} failed. */
    public static final String EIP3009_SIMULATION_FAILED = "invalid_exact_evm_transaction_simulation_failed";

    // Facilitator: EIP-3009 settle (exact/facilitator/errors.go)

    /** Settlement re-verified the payment and it was invalid. */
    public static final String VERIFICATION_FAILED = "invalid_exact_evm_verification_failed";

    /** The signature could not be split into {@code v}, {@code r} and {@code s}. */
    public static final String FAILED_TO_PARSE_SIGNATURE = "invalid_exact_evm_failed_to_parse_signature";

    /** Reserved wire value, not produced by this SDK. Do not reassign. */
    public static final String FAILED_TO_CHECK_DEPLOYMENT = "invalid_exact_evm_failed_to_check_deployment";

    /** The {@code transferWithAuthorization} transaction could not be sent. */
    public static final String FAILED_TO_EXECUTE_TRANSFER = "invalid_exact_evm_failed_to_execute_transfer";

    /** Reserved wire value of the v1 exact scheme. Do not reassign. */
    public static final String FAILED_TO_GET_RECEIPT = "invalid_exact_evm_failed_to_get_receipt";

    /** The settlement transaction was mined but reverted (receipt status 0). */
    public static final String TRANSACTION_FAILED = "invalid_exact_evm_transaction_failed";

    /** The mined transaction did not emit the expected {@code Transfer} event. */
    public static final String TRANSFER_EVENT_MISMATCH = "invalid_exact_evm_transfer_event_mismatch";

    // Facilitator: smart wallets (exact/facilitator/errors.go)

    /** The payer is an undeployed smart wallet and the signature carries no ERC-6492 deployment data. */
    public static final String UNDEPLOYED_SMART_WALLET = "invalid_exact_evm_payload_undeployed_smart_wallet";

    /** Deploying the payer's ERC-6492 smart wallet failed. */
    public static final String SMART_WALLET_DEPLOYMENT_FAILED = "smart_wallet_deployment_failed";

    /** The ERC-6492 factory is not on the facilitator's allowlist. */
    public static final String FACTORY_NOT_ALLOWED = "eip6492_factory_not_allowed";

    /** The payload type is not supported by the facilitator. */
    public static final String UNSUPPORTED_PAYLOAD_TYPE = "unsupported_payload_type";

    // Shared EVM (mechanisms/evm/errors.go)

    /** The asset address has no bytecode, so a transfer would silently do nothing. */
    public static final String ASSET_NOT_DEPLOYED_CONTRACT = "asset_not_deployed_contract";

    /**
     * The settlement transaction was broadcast but its receipt could not be confirmed. Non-terminal: it is
     * reported with the transaction hash so the caller can reconcile onchain before retrying.
     */
    public static final String SETTLEMENT_PENDING = "settlement_pending";

    private ExactEvmErrors() {
    }
}
