using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Roles.Errors;
using X402.Core.Roles.Hooks;
using Xunit;

namespace X402.Core.Tests.Roles;

public class X402ClientTests
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

    [Fact]
    public void Constructor_InitializesWithEmptyHandlers()
    {
        var client = new X402Client();
        Assert.NotNull(client);
    }

    [Fact]
    public void RegisterSchemeHandler_StoresHandler()
    {
        var client = new X402Client();
        Func<PaymentRequirements, Task<PaymentPayload>> handler = req =>
            Task.FromResult(CreateTestPayload(req.Scheme));

        client.RegisterSchemeHandler("evm-exact", handler);
        // Handler is stored internally; we verify via CreatePaymentPayloadAsync
    }

    [Fact]
    public async Task CreatePaymentPayloadAsync_CallsRegisteredHandler()
    {
        var client = new X402Client();
        var requirements = CreateTestRequirements();
        var expectedPayload = CreateTestPayload();

        Func<PaymentRequirements, Task<PaymentPayload>> handler = req =>
        {
            Assert.Equal("evm-exact", req.Scheme);
            return Task.FromResult(expectedPayload);
        };

        client.RegisterSchemeHandler("evm-exact", handler);
        var result = await client.CreatePaymentPayloadAsync(requirements);

        Assert.Equal(expectedPayload, result);
    }

    [Fact]
    public async Task CreatePaymentPayloadAsync_MultipleRequirements_SelectsSupportedScheme()
    {
        var client = new X402Client();
        var unsupported = CreateTestRequirements("svm-exact");
        var supported = CreateTestRequirements("evm-exact");
        var expectedPayload = CreateTestPayload();

        client.RegisterSchemeHandler("evm-exact", requirement =>
        {
            Assert.Equal("evm-exact", requirement.Scheme);
            return Task.FromResult(expectedPayload);
        });

        var result = await client.CreatePaymentPayloadAsync([unsupported, supported]);

        Assert.Equal(expectedPayload, result);
    }

    [Fact]
    public async Task CreatePaymentPayloadAsync_MultipleRequirements_ThrowsWhenNoSchemeSupported()
    {
        var client = new X402Client();

        var ex = await Assert.ThrowsAsync<PaymentError>(
            () => client.CreatePaymentPayloadAsync([
                CreateTestRequirements("svm-exact"),
            CreateTestRequirements("aptos-exact")
            ])
        );

        Assert.Equal("UNSUPPORTED_SCHEME", ex.ErrorCode);
        Assert.Contains("svm-exact", ex.Message);
        Assert.Contains("aptos-exact", ex.Message);
    }

    [Fact]
    public async Task CreatePaymentPayloadAsync_ThrowsForUnregisteredScheme()
    {
        var client = new X402Client();
        var requirements = CreateTestRequirements();

        var ex = await Assert.ThrowsAsync<PaymentError>(
            () => client.CreatePaymentPayloadAsync(requirements)
        );

        Assert.Equal("UNSUPPORTED_SCHEME", ex.ErrorCode);
        Assert.Contains("evm-exact", ex.Message);
    }

    [Fact]
    public async Task RegisterPolicy_EnforcesPolicy()
    {
        var client = new X402Client();
        var requirements = CreateTestRequirements();
        var payload = CreateTestPayload();

        client.RegisterSchemeHandler("evm-exact", _ => Task.FromResult(payload));
        client.RegisterPolicy("max-amount", p =>
        {
            var maxAmount = 500_000_000_000_000_000M; // 0.5 tokens
            var actualAmount = decimal.Parse(p.Accepted.Amount);
            return Task.FromResult(actualAmount <= maxAmount);
        });

        var ex = await Assert.ThrowsAsync<PaymentError>(
            () => client.CreatePaymentPayloadAsync(requirements)
        );

        Assert.Equal("POLICY_VIOLATION", ex.ErrorCode);
        Assert.Contains("max-amount", ex.Message);
    }

    [Fact]
    public async Task BeforePaymentCreation_Hook_CanAbort()
    {
        var client = new X402Client();
        var requirements = CreateTestRequirements();

        Func<PaymentRequirements, Task<PaymentPayload>> handler = _ =>
            Task.FromResult(CreateTestPayload());

        client.RegisterSchemeHandler("evm-exact", handler);

        var hooks = new TestClientHooks
        {
            BeforePaymentCreationAction = ctx =>
            {
                ctx.ShouldAbort = true;
                return Task.CompletedTask;
            }
        };

        client.RegisterHooks(hooks);

        var ex = await Assert.ThrowsAsync<PaymentError>(
            () => client.CreatePaymentPayloadAsync(requirements)
        );

        Assert.Equal("ABORTED_BY_HOOK", ex.ErrorCode);
    }

    [Fact]
    public async Task AfterPaymentCreation_Hook_IsInvoked()
    {
        var client = new X402Client();
        var requirements = CreateTestRequirements();
        var hookInvoked = false;

        Func<PaymentRequirements, Task<PaymentPayload>> handler = _ =>
            Task.FromResult(CreateTestPayload());

        client.RegisterSchemeHandler("evm-exact", handler);

        var hooks = new TestClientHooks
        {
            AfterPaymentCreationAction = ctx =>
            {
                hookInvoked = true;
                Assert.NotNull(ctx.Payload);
                return Task.CompletedTask;
            }
        };

        client.RegisterHooks(hooks);
        await client.CreatePaymentPayloadAsync(requirements);

        Assert.True(hookInvoked);
    }

    [Fact]
    public async Task OnPaymentCreationFailure_Hook_IsInvoked()
    {
        var client = new X402Client();
        var requirements = CreateTestRequirements();
        var hookInvoked = false;

        Func<PaymentRequirements, Task<PaymentPayload>> handler = _ =>
            throw new InvalidOperationException("Test error");

        client.RegisterSchemeHandler("evm-exact", handler);

        var hooks = new TestClientHooks
        {
            OnPaymentCreationFailureAction = ctx =>
            {
                hookInvoked = true;
                Assert.NotNull(ctx.Error);
                return Task.CompletedTask;
            }
        };

        client.RegisterHooks(hooks);

        await Assert.ThrowsAsync<PaymentError>(
            () => client.CreatePaymentPayloadAsync(requirements)
        );

        Assert.True(hookInvoked);
    }

    private class TestClientHooks : IClientHooks
    {
        public Func<ClientHookContext, Task>? BeforePaymentCreationAction { get; set; }
        public Func<ClientHookContext, Task>? AfterPaymentCreationAction { get; set; }
        public Func<ClientHookContext, Task>? OnPaymentCreationFailureAction { get; set; }

        public Task BeforePaymentCreationAsync(ClientHookContext context) =>
            BeforePaymentCreationAction?.Invoke(context) ?? Task.CompletedTask;

        public Task AfterPaymentCreationAsync(ClientHookContext context) =>
            AfterPaymentCreationAction?.Invoke(context) ?? Task.CompletedTask;

        public Task OnPaymentCreationFailureAsync(ClientHookContext context) =>
            OnPaymentCreationFailureAction?.Invoke(context) ?? Task.CompletedTask;
    }
}
