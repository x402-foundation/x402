using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Roles.Errors;
using X402.Mechanisms.Evm.Exact;

namespace X402.Mechanisms.Evm.Tests;

public class EvmExactClientSchemeTests
{
    private const string TestPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    private const string RecipientAddress = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    private const string TokenAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    private const string TokenName = "USD Coin";
    private const string TokenVersion = "2";

    private static PaymentRequirements CreateRequirements(JsonObject? extra = null, int maxTimeoutSeconds = 3600)
    {
        return new PaymentRequirements(
            Scheme: EvmSchemes.Exact,
            Network: EvmChains.BaseSepolia,
            Asset: TokenAddress,
            Amount: "1000000",
            PayTo: RecipientAddress,
            MaxTimeoutSeconds: maxTimeoutSeconds,
            Extra: extra ?? new JsonObject
            {
                ["name"] = TokenName,
                ["version"] = TokenVersion,
            });
    }

    [Fact]
    public async Task CreatePaymentPayloadAsync_BuildsVerifierCompatiblePayload()
    {
        var signer = new PrivateKeyEvmExactClientSigner(TestPrivateKey);
        var scheme = new EvmExactClientScheme(
            signer,
            () => DateTimeOffset.UtcNow.AddSeconds(-1),
            () => "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

        var payload = await scheme.CreatePaymentPayloadAsync(CreateRequirements());
        var verification = EvmExactVerifier.Verify(payload);

        Assert.Equal(2, payload.X402Version);
        Assert.Equal(EvmSchemes.Exact, payload.Accepted.Scheme);
        Assert.True(verification.IsValid);
        Assert.NotNull(verification.Payer);
    }

    [Fact]
    public async Task CreatePaymentPayloadAsync_MissingDomain_ThrowsPaymentError()
    {
        var signer = new PrivateKeyEvmExactClientSigner(TestPrivateKey);
        var scheme = new EvmExactClientScheme(signer);

        var ex = await Assert.ThrowsAsync<PaymentError>(
            () => scheme.CreatePaymentPayloadAsync(CreateRequirements(new JsonObject())));

        Assert.Equal("MISSING_EIP712_DOMAIN", ex.ErrorCode);
    }

    [Fact]
    public async Task RegisterEvmExact_RegistersSchemeHandlerOnClient()
    {
        var client = new X402Client();
        client.RegisterEvmExact(
            new PrivateKeyEvmExactClientSigner(TestPrivateKey),
            () => DateTimeOffset.FromUnixTimeSeconds(1_700_000_000),
            () => "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

        var payload = await client.CreatePaymentPayloadAsync(CreateRequirements());

        Assert.Equal(EvmSchemes.Exact, payload.Accepted.Scheme);
        Assert.NotNull(payload.Payload["signature"]);
    }
}