namespace X402.Mechanisms.Evm;

/// <summary>
/// Scheme name constant for the EVM Exact payment mechanism.
/// </summary>
public static class EvmSchemes
{
    /// <summary>"evm-exact" — v2 protocol scheme identifier.</summary>
    public const string Exact = "evm-exact";
}

/// <summary>
/// CAIP-2 network family for EVM chains.
/// </summary>
public static class EvmCaip2
{
    public const string Wildcard = "eip155:*";
}

/// <summary>
/// Well-known CAIP-2 chain identifiers.
/// </summary>
public static class EvmChains
{
    public const string Mainnet = "eip155:1";
    public const string BaseSepolia = "eip155:84532";
    public const string Base = "eip155:8453";
    public const string OptimismSepolia = "eip155:11155420";
    public const string Optimism = "eip155:10";
    public const string ArbitrumOne = "eip155:42161";
    public const string ArbitrumSepolia = "eip155:421614";
    public const string Sepolia = "eip155:11155111";
}

/// <summary>
/// Error reason strings returned in <see cref="X402.Core.Protocol.V2.VerifyResponse.InvalidReason"/>.
/// These match the canonical values used by the TypeScript and Go facilitators.
/// </summary>
public static class EvmExactErrors
{
    public const string InvalidScheme = "invalid_scheme";
    public const string NetworkMismatch = "network_mismatch";
    public const string InvalidPayload = "invalid_payload";
    public const string MissingSignature = "missing_signature";
    public const string MissingEip712Domain = "missing_eip712_domain";
    public const string RecipientMismatch = "recipient_mismatch";
    public const string AmountMismatch = "amount_mismatch";
    public const string InvalidRequiredAmount = "invalid_required_amount";
    public const string ValidBeforeExpired = "valid_before_expired";
    public const string ValidAfterInFuture = "valid_after_in_future";
    public const string InvalidSignatureFormat = "invalid_signature_format";
    public const string SignatureVerificationFailed = "signature_verification_failed";
    public const string InvalidNetworkFormat = "invalid_network_format";
}
