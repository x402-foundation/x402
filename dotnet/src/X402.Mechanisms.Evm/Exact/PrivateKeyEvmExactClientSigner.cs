using Nethereum.Signer;

namespace X402.Mechanisms.Evm.Exact;

/// <summary>
/// Local private-key signer for buyer-side <c>evm-exact</c> payload creation.
/// </summary>
public sealed class PrivateKeyEvmExactClientSigner : IEvmExactClientSigner
{
    private readonly EthECKey _key;

    public PrivateKeyEvmExactClientSigner(string privateKey)
    {
        _key = new EthECKey(privateKey);
    }

    public Task<string> GetAddressAsync() =>
        Task.FromResult(Eip712Hasher.NormalizeAddress(_key.GetPublicAddress()));

    public Task<string> SignTransferWithAuthorizationAsync(Eip3009Authorization authorization, Eip712DomainData domain)
    {
        var hash = Eip712Hasher.HashTransferWithAuthorization(
            from: authorization.From,
            to: authorization.To,
            value: authorization.Value,
            validAfter: authorization.ValidAfter,
            validBefore: authorization.ValidBefore,
            nonce: authorization.Nonce,
            chainId: domain.ChainId,
            verifyingContract: domain.VerifyingContract,
            tokenName: domain.Name,
            tokenVersion: domain.Version);

        var rawSignature = _key.SignAndCalculateV(hash);
        var vByte = rawSignature.V is { Length: > 0 } ? rawSignature.V[0] : (byte)0x1b;
        var signature = "0x"
            + BitConverter.ToString(rawSignature.R).Replace("-", string.Empty)
            + BitConverter.ToString(rawSignature.S).Replace("-", string.Empty)
            + vByte.ToString("x2");

        return Task.FromResult(signature);
    }
}