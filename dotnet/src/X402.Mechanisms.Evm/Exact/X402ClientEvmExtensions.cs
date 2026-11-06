using X402.Core.Roles;

namespace X402.Mechanisms.Evm.Exact;

/// <summary>
/// Registration helpers for buyer-side EVM payment schemes.
/// </summary>
public static class X402ClientEvmExtensions
{
    public static IX402Client RegisterEvmExact(
        this IX402Client client,
        IEvmExactClientSigner signer,
        Func<DateTimeOffset>? clock = null,
        Func<string>? nonceFactory = null)
    {
        var scheme = new EvmExactClientScheme(signer, clock, nonceFactory);
        client.RegisterSchemeHandler(EvmSchemes.Exact, scheme.CreatePaymentPayloadAsync);
        return client;
    }
}