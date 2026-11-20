using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Roles.Errors;
using X402.Core.Roles.Hooks;
using Xunit;

namespace X402.Core.Tests.Roles;

public class X402ResourceServerTests
{
    private static PaymentRequirements CreateTestRequirements(string scheme = "evm-exact")
    {
        return new PaymentRequirements(
            scheme,
            "eip155:84532",
            "USDC",
            "1000000000000000000", // 1 token
            "0x1234567890123456789012345678901234567890",
            3600
        );
    }

    private static PaymentPayload CreateTestPayload(string scheme = "evm-exact")
    {
        return new PaymentPayload(
            2,
            CreateTestRequirements(scheme),
            new JsonObject { ["sig"] = "test-signature" }
        );
    }

    private static VerifyResponse CreateValidVerifyResponse(string payer = "0xaaa")
    {
        return new VerifyResponse(
            true,
            null,
            payer
        );
    }

    [Fact]
    public void Constructor_InitializesWithEmptyHandlers()
    {
        var server = new X402ResourceServer();
        Assert.NotNull(server);
    }

    [Fact]
    public void Initialize_StoresRequirements()
    {
        var server = new X402ResourceServer();
        var requirements = CreateTestRequirements();

        server.Initialize("/api/data", requirements);
        // Verify via GetRequirementsAsync
    }

    [Fact]
    public async Task GetRequirementsAsync_ReturnsStoredRequirements()
    {
        var server = new X402ResourceServer();
        var requirements = CreateTestRequirements();

        server.Initialize("/api/data", requirements);
        var result = await server.GetRequirementsAsync("/api/data");

        Assert.Equal(requirements, result);
    }

    [Fact]
    public async Task GetRequirementsAsync_ReturnsNullForUnknownPath()
    {
        var server = new X402ResourceServer();
        var result = await server.GetRequirementsAsync("/unknown");

        Assert.Null(result);
    }

    [Fact]
    public async Task VerifyPaymentAsync_CallsRegisteredVerifier()
    {
        var server = new X402ResourceServer();
        var payload = CreateTestPayload();
        var expectedResponse = CreateValidVerifyResponse();

        Func<PaymentPayload, Task<VerifyResponse>> verifier = p =>
        {
            Assert.Equal("evm-exact", p.Accepted.Scheme);
            return Task.FromResult(expectedResponse);
        };

        server.RegisterSchemeVerifier("evm-exact", verifier);
        var result = await server.VerifyPaymentAsync(payload);

        Assert.Equal(expectedResponse, result);
    }

    [Fact]
    public async Task VerifyPaymentAsync_FacilitatedScheme_UsesConfiguredClient()
    {
        var client = new FakeFacilitatorClient();
        var server = new X402ResourceServer(client);
        var payload = CreateTestPayload();

        server.RegisterFacilitatedScheme("evm-exact");
        var result = await server.VerifyPaymentAsync(payload, "https://facilitator.example.com");

        Assert.True(result.IsValid);
        Assert.Equal("https://facilitator.example.com", client.LastVerifyUrl);
    }

    [Fact]
    public async Task SettlePaymentAsync_FacilitatedScheme_UsesConfiguredClient()
    {
        var client = new FakeFacilitatorClient();
        var server = new X402ResourceServer(client);
        var payload = CreateTestPayload();

        server.RegisterFacilitatedScheme("evm-exact");
        var result = await server.SettlePaymentAsync(payload, "https://facilitator.example.com");

        Assert.True(result.Success);
        Assert.Equal("https://facilitator.example.com", client.LastSettleUrl);
    }

    [Fact]
    public async Task VerifyPaymentAsync_ThrowsForUnregisteredScheme()
    {
        var server = new X402ResourceServer();
        var payload = CreateTestPayload();

        var ex = await Assert.ThrowsAsync<VerifyError>(
            () => server.VerifyPaymentAsync(payload)
        );

        Assert.Equal("UNSUPPORTED_SCHEME", ex.InvalidReason);
        Assert.Contains("evm-exact", ex.Message);
    }

    [Fact]
    public async Task BeforeVerifyAsync_Hook_CanAbort()
    {
        var server = new X402ResourceServer();
        var payload = CreateTestPayload();

        Func<PaymentPayload, Task<VerifyResponse>> verifier = _ =>
            Task.FromResult(CreateValidVerifyResponse());

        server.RegisterSchemeVerifier("evm-exact", verifier);

        var hooks = new TestServerHooks
        {
            BeforeVerifyAction = ctx =>
            {
                ctx.ShouldAbort = true;
                return Task.CompletedTask;
            }
        };

        server.RegisterHooks(hooks);

        var ex = await Assert.ThrowsAsync<VerifyError>(
            () => server.VerifyPaymentAsync(payload)
        );

        Assert.Equal("ABORTED_BY_HOOK", ex.InvalidReason);
    }

    [Fact]
    public async Task AfterVerifyAsync_Hook_IsInvoked()
    {
        var server = new X402ResourceServer();
        var payload = CreateTestPayload();
        var hookInvoked = false;

        Func<PaymentPayload, Task<VerifyResponse>> verifier = _ =>
            Task.FromResult(CreateValidVerifyResponse());

        server.RegisterSchemeVerifier("evm-exact", verifier);

        var hooks = new TestServerHooks
        {
            AfterVerifyAction = ctx =>
            {
                hookInvoked = true;
                Assert.NotNull(ctx.VerifyResponse);
                return Task.CompletedTask;
            }
        };

        server.RegisterHooks(hooks);
        await server.VerifyPaymentAsync(payload);

        Assert.True(hookInvoked);
    }

    [Fact]
    public async Task OnVerifyFailureAsync_Hook_IsInvoked()
    {
        var server = new X402ResourceServer();
        var payload = CreateTestPayload();
        var hookInvoked = false;

        Func<PaymentPayload, Task<VerifyResponse>> verifier = _ =>
            throw new InvalidOperationException("Verification error");

        server.RegisterSchemeVerifier("evm-exact", verifier);

        var hooks = new TestServerHooks
        {
            OnVerifyFailureAction = ctx =>
            {
                hookInvoked = true;
                Assert.NotNull(ctx.Error);
                return Task.CompletedTask;
            }
        };

        server.RegisterHooks(hooks);

        await Assert.ThrowsAsync<VerifyError>(
            () => server.VerifyPaymentAsync(payload)
        );

        Assert.True(hookInvoked);
    }

    [Fact]
    public async Task SettlePaymentAsync_ThrowsNotImplemented()
    {
        var server = new X402ResourceServer();
        var payload = CreateTestPayload();

        await Assert.ThrowsAsync<NotImplementedException>(
            () => server.SettlePaymentAsync(payload)
        );
    }

    private class TestServerHooks : IServerHooks
    {
        public Func<ServerHookContext, Task>? BeforeVerifyAction { get; set; }
        public Func<ServerHookContext, Task>? AfterVerifyAction { get; set; }
        public Func<ServerHookContext, Task>? OnVerifyFailureAction { get; set; }

        public Task BeforeVerifyAsync(ServerHookContext context) =>
            BeforeVerifyAction?.Invoke(context) ?? Task.CompletedTask;

        public Task AfterVerifyAsync(ServerHookContext context) =>
            AfterVerifyAction?.Invoke(context) ?? Task.CompletedTask;

        public Task OnVerifyFailureAsync(ServerHookContext context) =>
            OnVerifyFailureAction?.Invoke(context) ?? Task.CompletedTask;
    }

    private sealed class FakeFacilitatorClient : IX402FacilitatorClient
    {
        public string? LastVerifyUrl { get; private set; }
        public string? LastSettleUrl { get; private set; }

        public Task<VerifyResponse> VerifyAsync(PaymentPayload payload, string? facilitatorUrl = null)
        {
            LastVerifyUrl = facilitatorUrl;
            return Task.FromResult(CreateValidVerifyResponse("0xfacilitated"));
        }

        public Task<SettleResponse> SettleAsync(PaymentPayload payload, string? facilitatorUrl = null)
        {
            LastSettleUrl = facilitatorUrl;
            return Task.FromResult(new SettleResponse(true, "0xtx", "eip155:84532", null, "0xfacilitated", payload.Accepted.Amount));
        }
    }
}
