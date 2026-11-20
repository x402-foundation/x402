using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Transport.Http;
using X402.AspNetCore;

namespace X402.AspNetCore.Tests;

/// <summary>
/// Unit tests for <see cref="X402PaymentMiddleware"/>.
/// Uses a hand-rolled <see cref="FakeResourceServer"/> instead of mocking
/// to keep the test project dependency-free.
/// </summary>
public class X402PaymentMiddlewareTests
{
    // ─── helpers ───────────────────────────────────────────────────────────

    private static PaymentRequirements MakeRequirements() =>
        new("evm-exact", "eip155:84532", "0xtoken", "1000000000000000000", "0xrecipient", 60, null);

    private static X402MiddlewareOptions MakeOptions() =>
        new X402MiddlewareOptions().Protect("/api/premium", MakeRequirements());

    private static HttpContext MakeContext(string path, string? paymentHeader = null)
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Path = path;
        ctx.Response.Body = new System.IO.MemoryStream();
        if (paymentHeader is not null)
            ctx.Request.Headers.Append(X402HttpHeaders.PaymentSignature, paymentHeader);
        return ctx;
    }

    private static string MakePaymentHeader(FakeResourceServer? server = null)
    {
        var requirements = MakeRequirements();
        var payload = new PaymentPayload(
            2,
            requirements,
            new JsonObject { ["signature"] = "0xdeadbeef" },
            null,
            null
        );
        return HeaderCodec.Encode(payload);
    }

    // ─── fake server ───────────────────────────────────────────────────────

    private sealed class FakeResourceServer : IX402ResourceServer
    {
        private readonly bool _verifyResult;
        private readonly string? _invalidReason;
        private PaymentRequirements? _stored;

        public FakeResourceServer(bool verifyResult = true, string? invalidReason = null)
        {
            _verifyResult = verifyResult;
            _invalidReason = invalidReason;
        }

        public void Initialize(string resourcePath, PaymentRequirements requirements) =>
            _stored = requirements;

        public void RegisterSchemeVerifier(string scheme, Func<PaymentPayload, Task<VerifyResponse>> verifier) { }

        public void RegisterFacilitatedScheme(string scheme) { }

        public void RegisterHooks(X402.Core.Roles.Hooks.IServerHooks hooks) { }

        public Task<VerifyResponse> VerifyPaymentAsync(PaymentPayload payload, string? facilitatorUrl = null) =>
            Task.FromResult(_verifyResult
                ? new VerifyResponse(true, null, "0xpayer")
                : new VerifyResponse(false, _invalidReason ?? "INVALID", null));

        public Task<SettleResponse> SettlePaymentAsync(PaymentPayload payload, string? facilitatorUrl = null) =>
            Task.FromResult(new SettleResponse(true, "0xtx", "eip155:84532", null, null, null));

        public Task<PaymentRequirements?> GetRequirementsAsync(string resourcePath) =>
            Task.FromResult(_stored);
    }

    private static X402PaymentMiddleware MakeMiddleware(
        RequestDelegate next,
        FakeResourceServer? server = null,
        X402MiddlewareOptions? options = null)
    {
        server ??= new FakeResourceServer();
        options ??= MakeOptions();
        var enforcer = new X402PaymentEnforcer(server);
        return new X402PaymentMiddleware(next, options, server, enforcer);
    }

    // ─── tests ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task UnprotectedRoute_PassesThrough()
    {
        var nextCalled = false;
        var mw = MakeMiddleware(_ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = MakeContext("/api/public");

        await mw.InvokeAsync(ctx);

        Assert.True(nextCalled);
        Assert.Equal(200, ctx.Response.StatusCode); // default
    }

    [Fact]
    public async Task ProtectedRoute_NoPaymentHeader_Returns402()
    {
        var mw = MakeMiddleware(_ => Task.CompletedTask);
        var ctx = MakeContext("/api/premium");

        await mw.InvokeAsync(ctx);

        Assert.Equal(402, ctx.Response.StatusCode);
        Assert.True(ctx.Response.Headers.ContainsKey(X402HttpHeaders.PaymentRequired),
            "402 response must include PaymentRequired header");
    }

    [Fact]
    public async Task ProtectedRouteSubPath_NoPaymentHeader_Returns402()
    {
        var mw = MakeMiddleware(_ => Task.CompletedTask);
        var ctx = MakeContext("/api/premium/video/42");

        await mw.InvokeAsync(ctx);

        Assert.Equal(402, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task ProtectedRoute_ValidPayment_CallsNext()
    {
        var nextCalled = false;
        var mw = MakeMiddleware(_ => { nextCalled = true; return Task.CompletedTask; },
                                new FakeResourceServer(verifyResult: true));
        var ctx = MakeContext("/api/premium", MakePaymentHeader());

        await mw.InvokeAsync(ctx);

        Assert.True(nextCalled);
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task ProtectedRoute_ValidPayment_AttachesPayerToContext()
    {
        var mw = MakeMiddleware(_ => Task.CompletedTask, new FakeResourceServer(verifyResult: true));
        var ctx = MakeContext("/api/premium", MakePaymentHeader());

        await mw.InvokeAsync(ctx);

        Assert.Equal("0xpayer", ctx.Items[X402HttpContextKeys.Payer]);
    }

    [Fact]
    public async Task ProtectedRoute_AlreadyVerified_SkipsMiddlewareEnforcement()
    {
        var nextCalled = false;
        var mw = MakeMiddleware(_ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = MakeContext("/api/premium");
        ctx.Items[X402HttpContextKeys.Verified] = true;

        await mw.InvokeAsync(ctx);

        Assert.True(nextCalled);
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task ProtectedRoute_InvalidPayment_Returns403()
    {
        var mw = MakeMiddleware(_ => Task.CompletedTask,
                                new FakeResourceServer(verifyResult: false, invalidReason: "EXPIRED"));
        var ctx = MakeContext("/api/premium", MakePaymentHeader());

        await mw.InvokeAsync(ctx);

        Assert.Equal(403, ctx.Response.StatusCode);
        Assert.Equal("EXPIRED", ctx.Response.Headers["x402-invalid-reason"].ToString());
    }

    [Fact]
    public async Task ProtectedRoute_MalformedPaymentHeader_Returns403()
    {
        var mw = MakeMiddleware(_ => Task.CompletedTask);
        var ctx = MakeContext("/api/premium", "not-valid-base64!!!");

        await mw.InvokeAsync(ctx);

        Assert.Equal(403, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task MultipleProtectedRoutes_EachMatchesCorrectly()
    {
        var options = new X402MiddlewareOptions()
            .Protect("/api/premium", MakeRequirements())
            .Protect("/api/exclusive", MakeRequirements());
        var mw = MakeMiddleware(_ => Task.CompletedTask, new FakeResourceServer(), options);

        var ctxPremium = MakeContext("/api/premium");
        var ctxExclusive = MakeContext("/api/exclusive");
        var ctxPublic = MakeContext("/api/public");

        await mw.InvokeAsync(ctxPremium);
        await mw.InvokeAsync(ctxExclusive);
        await mw.InvokeAsync(ctxPublic);

        Assert.Equal(402, ctxPremium.Response.StatusCode);
        Assert.Equal(402, ctxExclusive.Response.StatusCode);
        Assert.Equal(200, ctxPublic.Response.StatusCode);
    }

    [Fact]
    public async Task ProtectedRoute_PaymentRequired_HeaderContainsEncodedRequirements()
    {
        var mw = MakeMiddleware(_ => Task.CompletedTask);
        var ctx = MakeContext("/api/premium");

        await mw.InvokeAsync(ctx);

        Assert.Equal(402, ctx.Response.StatusCode);
        var rawHeader = ctx.Response.Headers[X402HttpHeaders.PaymentRequired].ToString();
        Assert.NotEmpty(rawHeader);

        var decoded = HeaderCodec.Decode<PaymentRequired>(rawHeader);
        Assert.NotNull(decoded);
        Assert.Equal(2, decoded.X402Version);
        Assert.NotEmpty(decoded.Accepts);
        Assert.Equal("evm-exact", decoded.Accepts[0].Scheme);
    }
}
