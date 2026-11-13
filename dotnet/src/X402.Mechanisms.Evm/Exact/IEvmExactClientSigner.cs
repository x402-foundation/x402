using X402.Mechanisms.Evm.Exact;

namespace X402.Mechanisms.Evm.Exact;

/// <summary>
/// Wallet-agnostic signer contract for buyer-side <c>evm-exact</c> payments.
/// </summary>
public interface IEvmExactClientSigner
{
    /// <summary>
    /// Returns the payer address that will authorize payments.
    /// </summary>
    Task<string> GetAddressAsync();

    /// <summary>
    /// Signs an EIP-3009 <c>TransferWithAuthorization</c> payload for the supplied domain.
    /// </summary>
    Task<string> SignTransferWithAuthorizationAsync(Eip3009Authorization authorization, Eip712DomainData domain);
}

/// <summary>
/// EIP-712 domain data required to sign a transfer authorization.
/// </summary>
public sealed record Eip712DomainData(
    string Name,
    string Version,
    long ChainId,
    string VerifyingContract
);