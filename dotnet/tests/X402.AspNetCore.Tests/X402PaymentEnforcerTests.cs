using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using X402.AspNetCore;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Transport.Http;

namespace X402.AspNetCore.Tests;

public class X402PaymentEnforcerTests
{
    private static PaymentRequirements MakeRequirements() =>
        new("evm-exact", "eip155:84532", "0xtoken", "1000000000000000000", "0xrecipient", 60, null);

    private static HttpContext MakeContext(string path, string? paymentHeader = null)
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Path = path;
        ctx.Response.Body = new System.IO.MemoryStream();
        if (paymentHeader is not null)
            ctx.Request.Headers.Append(X402HttpHeaders.PaymentSignature, paymentHeader);
        return ctx;
    }

    private static string MakePaymentHeader()
    {
        var payload = new PaymentPayload(
            2,
            MakeRequirements(),
            new JsonObject { ["signature"] = "0xdeadbeef" },
            null,
            null);
        return HeaderCodec.Encode(payload);
    }

    private sealed class FakeResourceServer : IX402ResourceServer
    {
        private readonly bool _verifyResult;

        public FakeResourceServer(bool verifyResult = true)
        {
            _verifyResult = verifyResult;
        }

        public int VerifyCalls { get; private set; }
        public string? LastFacilitatorUrl { get; private set; }

        public void Initialize(string resourcePath, PaymentRequirements requirements) { }

        public void RegisterSchemeVerifier(string scheme, Func<PaymentPayload, Task<VerifyResponse>> verifier) { }

        public void RegisterFacilitatedScheme(string scheme) { }

        public void RegisterHooks(X402.Core.Roles.Hooks.IServerHooks hooks) { }

        public Task<VerifyResponse> VerifyPaymentAsync(PaymentPayload payload, string? facilitatorUrl = null)
        {
            VerifyCalls++;
            LastFacilitatorUrl = facilitatorUrl;
            return Task.FromResult(_verifyResult
                ? new VerifyResponse(true, null, "0xpayer")
                : new VerifyResponse(false, "INVALID", null));
        }

        public Task<SettleResponse> SettlePaymentAsync(PaymentPayload payload, string? facilitatorUrl = null) =>
            Task.FromResult(new SettleResponse(true, "0xtx", "eip155:84532", null, null, null));

        public Task<PaymentRequirements?> GetRequirementsAsync(string resourcePath) =>
            Task.FromResult<PaymentRequirements?>(MakeRequirements());
    }

    [Fact]
    public async Task MissingPaymentHeader_Returns402AndChallengeHeader()
    {
        var server = new FakeResourceServer();
        var enforcer = new X402PaymentEnforcer(server);
        var ctx = MakeContext("/api/premium");

        var allowed = await enforcer.EnforceAsync(ctx, MakeRequirements(), "/api/premium");

        Assert.False(allowed);
        Assert.Equal(402, ctx.Response.StatusCode);
        Assert.True(ctx.Response.Headers.ContainsKey(X402HttpHeaders.PaymentRequired));
        Assert.Equal(0, server.VerifyCalls);
    }

    [Fact]
    public async Task ValidPaymentHeader_VerifiesAndSetsContextItems()
    {
        var server = new FakeResourceServer(verifyResult: true);
        var enforcer = new X402PaymentEnforcer(server);
        var ctx = MakeContext("/api/premium", MakePaymentHeader());

        var allowed = await enforcer.EnforceAsync(ctx, MakeRequirements(), "/api/premium");

        Assert.True(allowed);
        Assert.Equal(1, server.VerifyCalls);
        Assert.Equal("0xpayer", ctx.Items[X402HttpContextKeys.Payer]);
        Assert.True(ctx.Items.ContainsKey(X402HttpContextKeys.Payload));
        Assert.Equal(true, ctx.Items[X402HttpContextKeys.Verified]);
    }

    [Fact]
    public async Task ValidPaymentHeader_UsesDefaultFacilitatorUrlFromRuntimeOptions()
    {
        var server = new FakeResourceServer(verifyResult: true);
        var enforcer = new X402PaymentEnforcer(server, new X402RuntimeOptions
        {
            DefaultFacilitatorUrl = "https://default-facilitator.example.com"
        });
        var ctx = MakeContext("/api/premium", MakePaymentHeader());

        var allowed = await enforcer.EnforceAsync(ctx, MakeRequirements(), "/api/premium");

        Assert.True(allowed);
        Assert.Equal("https://default-facilitator.example.com", server.LastFacilitatorUrl);
    }

    [Fact]
    public async Task ValidPaymentHeader_ExplicitFacilitatorUrlOverridesDefault()
    {
        var server = new FakeResourceServer(verifyResult: true);
        var enforcer = new X402PaymentEnforcer(server, new X402RuntimeOptions
        {
            DefaultFacilitatorUrl = "https://default-facilitator.example.com"
        });
        var ctx = MakeContext("/api/premium", MakePaymentHeader());

        var allowed = await enforcer.EnforceAsync(
            ctx,
            MakeRequirements(),
            "/api/premium",
            "https://route-facilitator.example.com");

        Assert.True(allowed);
        Assert.Equal("https://route-facilitator.example.com", server.LastFacilitatorUrl);
    }
}
