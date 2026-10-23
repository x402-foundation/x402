using System.Numerics;
using System.Text.Json.Nodes;
using Nethereum.Signer;
using X402.Core.Protocol.V2;
using X402.Mechanisms.Evm;
using X402.Mechanisms.Evm.Exact;

namespace X402.Mechanisms.Evm.Tests;

/// <summary>
/// Round-trip tests for <see cref="EvmExactVerifier"/>.
///
/// A deterministic test private key is used to create real EIP-712 signatures,
/// which are then verified by the verifier under test.
/// </summary>
public class EvmExactVerifierTests
{
    // ─── Deterministic test fixtures ────────────────────────────────────────

    /// <summary>Test-only private key — never use in production.</summary>
    private const string TestPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    private static readonly EthECKey _key = new(TestPrivateKey);
    private static readonly string _payerAddress;
    private static readonly string _recipientAddress = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    private static readonly string _tokenAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    private const string TokenName = "USD Coin";
    private const string TokenVersion = "2";
    private const string Network = EvmChains.BaseSepolia;   // "eip155:84532"
    private const long ChainId = 84532;
    private const string Amount = "1000000"; // 1 USDC (6 decimals)

    static EvmExactVerifierTests()
    {
        _payerAddress = _key.GetPublicAddress().ToLowerInvariant();
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    private static (PaymentPayload payload, string signature) BuildValidPayload(
        string? fromOverride = null,
        string? toOverride = null,
        string? valueOverride = null,
        string? validAfterOverride = null,
        string? validBeforeOverride = null,
        string? nonceOverride = null)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var auth = new Eip3009Authorization
        {
            From = fromOverride ?? _payerAddress,
            To = toOverride ?? _recipientAddress,
            Value = valueOverride ?? Amount,
            ValidAfter = validAfterOverride ?? (now - 600).ToString(),
            ValidBefore = validBeforeOverride ?? (now + 3600).ToString(),
            Nonce = nonceOverride ?? "0x" + Guid.NewGuid().ToString("N").PadLeft(64, '0')[..64],
        };

        var hash = Eip712Hasher.HashTransferWithAuthorization(
            from: auth.From,
            to: auth.To,
            value: auth.Value,
            validAfter: auth.ValidAfter,
            validBefore: auth.ValidBefore,
            nonce: auth.Nonce,
            chainId: ChainId,
            verifyingContract: _tokenAddress,
            tokenName: TokenName,
            tokenVersion: TokenVersion);

        // SignAndCalculateV sets V to 27/28, required for signature recovery
        var rawSig = _key.SignAndCalculateV(hash);
        var vByte = (rawSig.V != null && rawSig.V.Length > 0) ? rawSig.V[0] : (byte)0x1b;
        var signature = "0x" + BitConverter.ToString(rawSig.R).Replace("-", "")
                             + BitConverter.ToString(rawSig.S).Replace("-", "")
                             + vByte.ToString("x2");

        var payloadJson = new JsonObject
        {
            ["authorization"] = new JsonObject
            {
                ["from"] = auth.From,
                ["to"] = auth.To,
                ["value"] = auth.Value,
                ["validAfter"] = auth.ValidAfter,
                ["validBefore"] = auth.ValidBefore,
                ["nonce"] = auth.Nonce,
            },
            ["signature"] = signature,
        };

        var requirements = new PaymentRequirements(
            Scheme: EvmSchemes.Exact,
            Network: Network,
            Asset: _tokenAddress,
            Amount: Amount,
            PayTo: _recipientAddress,
            MaxTimeoutSeconds: 3600,
            Extra: new JsonObject
            {
                ["name"] = TokenName,
                ["version"] = TokenVersion,
            });

        var payload = new PaymentPayload(
            X402Version: 2,
            Accepted: requirements,
            Payload: payloadJson,
            Resource: null,
            Extensions: null);

        return (payload, signature);
    }

    // ─── tests ──────────────────────────────────────────────────────────────

    [Fact]
    public void Verify_ValidPayload_ReturnsValid()
    {
        var (payload, _) = BuildValidPayload();

        var result = EvmExactVerifier.Verify(payload);

        Assert.True(result.IsValid);
        Assert.Equal(_payerAddress, result.Payer);
        Assert.Null(result.InvalidReason);
    }

    [Fact]
    public void Verify_WrongScheme_ReturnsInvalid()
    {
        var (payload, _) = BuildValidPayload();
        var wrongScheme = payload.Accepted with { Scheme = "wrong-scheme" };
        var modified = payload with { Accepted = wrongScheme };

        var result = EvmExactVerifier.Verify(modified);

        Assert.False(result.IsValid);
        Assert.Equal(EvmExactErrors.InvalidScheme, result.InvalidReason);
    }

    [Fact]
    public void Verify_MissingEip712DomainInExtra_ReturnsInvalid()
    {
        var (payload, _) = BuildValidPayload();
        var noExtra = payload.Accepted with { Extra = null };
        var modified = payload with { Accepted = noExtra };

        var result = EvmExactVerifier.Verify(modified);

        Assert.False(result.IsValid);
        Assert.Equal(EvmExactErrors.MissingEip712Domain, result.InvalidReason);
    }

    [Fact]
    public void Verify_RecipientMismatch_ReturnsInvalid()
    {
        var (payload, _) = BuildValidPayload(toOverride: "0x0000000000000000000000000000000000000001");

        var result = EvmExactVerifier.Verify(payload);

        Assert.False(result.IsValid);
        Assert.Equal(EvmExactErrors.RecipientMismatch, result.InvalidReason);
    }

    [Fact]
    public void Verify_AmountMismatch_ReturnsInvalid()
    {
        var (payload, _) = BuildValidPayload(valueOverride: "999999"); // 1 unit short

        var result = EvmExactVerifier.Verify(payload);

        Assert.False(result.IsValid);
        Assert.Equal(EvmExactErrors.AmountMismatch, result.InvalidReason);
    }

    [Fact]
    public void Verify_ExpiredValidBefore_ReturnsInvalid()
    {
        long past = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 60; // expired 1 min ago
        var (payload, _) = BuildValidPayload(validBeforeOverride: past.ToString());

        var result = EvmExactVerifier.Verify(payload);

        Assert.False(result.IsValid);
        Assert.Equal(EvmExactErrors.ValidBeforeExpired, result.InvalidReason);
    }

    [Fact]
    public void Verify_ValidAfterInFuture_ReturnsInvalid()
    {
        long future = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 9999;
        var (payload, _) = BuildValidPayload(validAfterOverride: future.ToString());

        var result = EvmExactVerifier.Verify(payload);

        Assert.False(result.IsValid);
        Assert.Equal(EvmExactErrors.ValidAfterInFuture, result.InvalidReason);
    }

    [Fact]
    public void Verify_WrongSigner_SignatureVerificationFailed()
    {
        // Build a valid payload then replace the "from" address with a different address
        var (payload, _) = BuildValidPayload();
        var wrongAddress = "0x0000000000000000000000000000000000000002";

        // Mutate the payload JSON to use a different "from" (but keep the original signature)
        var auth = (JsonObject)payload.Payload!["authorization"]!;
        auth["from"] = wrongAddress;

        var wrongRequirements = payload.Accepted with { };  // requirements unchanged
        var modified = payload with
        {
            Accepted = wrongRequirements,
            Payload = payload.Payload,
        };

        var result = EvmExactVerifier.Verify(modified);

        Assert.False(result.IsValid);
        Assert.Equal(EvmExactErrors.SignatureVerificationFailed, result.InvalidReason);
    }

    [Fact]
    public void Verify_NullPayload_ReturnsInvalid()
    {
        var (payload, _) = BuildValidPayload();
        var modified = payload with { Payload = null };

        var result = EvmExactVerifier.Verify(modified);

        Assert.False(result.IsValid);
        Assert.Equal(EvmExactErrors.InvalidPayload, result.InvalidReason);
    }

    [Fact]
    public void Eip712Hasher_SameInputs_ProduceDeterministicHash()
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var nonce = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

        var hash1 = Eip712Hasher.HashTransferWithAuthorization(
            _payerAddress, _recipientAddress, Amount,
            (now - 600).ToString(), (now + 3600).ToString(), nonce,
            ChainId, _tokenAddress, TokenName, TokenVersion);

        var hash2 = Eip712Hasher.HashTransferWithAuthorization(
            _payerAddress, _recipientAddress, Amount,
            (now - 600).ToString(), (now + 3600).ToString(), nonce,
            ChainId, _tokenAddress, TokenName, TokenVersion);

        Assert.Equal(hash1, hash2);
    }

    [Fact]
    public void Verify_CreateFuncFactory_WorksAsVerifier()
    {
        var verifier = EvmExactVerifier.Create();
        var (payload, _) = BuildValidPayload();

        var result = verifier(payload).GetAwaiter().GetResult();

        Assert.True(result.IsValid);
    }
}
