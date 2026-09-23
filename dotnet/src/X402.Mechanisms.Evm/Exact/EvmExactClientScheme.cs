using System.Security.Cryptography;
using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Roles.Errors;

namespace X402.Mechanisms.Evm.Exact;

/// <summary>
/// Buyer-side payload builder for the <c>evm-exact</c> scheme.
/// </summary>
public sealed class EvmExactClientScheme
{
    private readonly IEvmExactClientSigner _signer;
    private readonly Func<DateTimeOffset> _clock;
    private readonly Func<string> _nonceFactory;

    public EvmExactClientScheme(
        IEvmExactClientSigner signer,
        Func<DateTimeOffset>? clock = null,
        Func<string>? nonceFactory = null)
    {
        _signer = signer;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _nonceFactory = nonceFactory ?? CreateNonce;
    }

    public async Task<PaymentPayload> CreatePaymentPayloadAsync(PaymentRequirements requirements)
    {
        if (!string.Equals(requirements.Scheme, EvmSchemes.Exact, StringComparison.Ordinal))
        {
            throw new PaymentError("UNSUPPORTED_SCHEME", $"Cannot build payment payload for scheme: {requirements.Scheme}");
        }

        var domain = BuildDomain(requirements);
        var payer = Eip712Hasher.NormalizeAddress(await _signer.GetAddressAsync());
        var now = _clock().ToUnixTimeSeconds();
        if (requirements.MaxTimeoutSeconds <= 6)
        {
            throw new PaymentError("INVALID_TIMEOUT", "Payment timeout must exceed 6 seconds for verifier safety checks");
        }

        var authorization = new Eip3009Authorization
        {
            From = payer,
            To = Eip712Hasher.NormalizeAddress(requirements.PayTo),
            Value = requirements.Amount,
            ValidAfter = now.ToString(),
            ValidBefore = (now + requirements.MaxTimeoutSeconds).ToString(),
            Nonce = _nonceFactory(),
        };

        var signature = await _signer.SignTransferWithAuthorizationAsync(authorization, domain);
        var payload = new JsonObject
        {
            ["authorization"] = new JsonObject
            {
                ["from"] = authorization.From,
                ["to"] = authorization.To,
                ["value"] = authorization.Value,
                ["validAfter"] = authorization.ValidAfter,
                ["validBefore"] = authorization.ValidBefore,
                ["nonce"] = authorization.Nonce,
            },
            ["signature"] = signature,
        };

        return new PaymentPayload(2, requirements, payload);
    }

    private static Eip712DomainData BuildDomain(PaymentRequirements requirements)
    {
        var extra = requirements.Extra;
        if (extra is null
            || !extra.TryGetPropertyValue("name", out var nameNode) || nameNode is null
            || !extra.TryGetPropertyValue("version", out var versionNode) || versionNode is null)
        {
            throw new PaymentError("MISSING_EIP712_DOMAIN", "Payment requirements are missing EIP-712 domain metadata");
        }

        var name = nameNode.GetValue<string>();
        var version = versionNode.GetValue<string>();
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(version))
        {
            throw new PaymentError("MISSING_EIP712_DOMAIN", "Payment requirements are missing EIP-712 domain metadata");
        }

        long chainId;
        try
        {
            chainId = Eip712Hasher.ChainIdFromCaip2(requirements.Network);
        }
        catch (FormatException ex)
        {
            throw new PaymentError("INVALID_NETWORK", ex.Message, ex);
        }

        return new Eip712DomainData(name, version, chainId, Eip712Hasher.NormalizeAddress(requirements.Asset));
    }

    private static string CreateNonce()
    {
        Span<byte> nonceBytes = stackalloc byte[32];
        RandomNumberGenerator.Fill(nonceBytes);
        return "0x" + Convert.ToHexString(nonceBytes).ToLowerInvariant();
    }
}