using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Roles.Errors;
using X402.Core.Roles.Hooks;
using Xunit;

namespace X402.Core.Tests.Roles;

public class X402FacilitatorTests
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

    private static VerifyResponse CreateValidVerifyResponse(string payer = "0xbbb")
    {
        return new VerifyResponse(
            true,
            null,
            payer
        );
    }

    private static SettleResponse CreateValidSettleResponse(string payer = "0xbbb")
    {
        return new SettleResponse(
            true,
            "0xtxhash",
            "eip155:84532",
            null,
            payer,
            "1000000000000000000"
        );
    }

    [Fact]
    public void Constructor_InitializesWithEmptyHandlers()
    {
        var facilitator = new X402Facilitator();
        Assert.NotNull(facilitator);
    }

    [Fact]
    public async Task VerifyAsync_CallsRegisteredVerifier()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();
        var expectedResponse = CreateValidVerifyResponse();

        Func<PaymentPayload, Task<VerifyResponse>> verifier = p =>
        {
            Assert.Equal("evm-exact", p.Accepted.Scheme);
            return Task.FromResult(expectedResponse);
        };

        facilitator.RegisterSchemeVerifier("evm-exact", verifier);
        var result = await facilitator.VerifyAsync(payload);

        Assert.Equal(expectedResponse, result);
    }

    [Fact]
    public async Task VerifyAsync_ThrowsForUnregisteredScheme()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();

        var ex = await Assert.ThrowsAsync<VerifyError>(
            () => facilitator.VerifyAsync(payload)
        );

        Assert.Equal("UNSUPPORTED_SCHEME", ex.InvalidReason);
    }

    [Fact]
    public async Task SettleAsync_CallsRegisteredSettler()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();
        var expectedResponse = CreateValidSettleResponse();

        Func<PaymentPayload, Task<SettleResponse>> settler = p =>
        {
            Assert.Equal("evm-exact", p.Accepted.Scheme);
            return Task.FromResult(expectedResponse);
        };

        facilitator.RegisterSchemeSettler("evm-exact", settler);
        var result = await facilitator.SettleAsync(payload);

        Assert.Equal(expectedResponse, result);
    }

    [Fact]
    public async Task SettleAsync_ThrowsForUnregisteredScheme()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();

        var ex = await Assert.ThrowsAsync<SettleError>(
            () => facilitator.SettleAsync(payload)
        );

        Assert.Equal("UNSUPPORTED_SCHEME", ex.ErrorReason);
    }

    [Fact]
    public async Task BeforeVerifyAsync_Hook_CanAbort()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();

        Func<PaymentPayload, Task<VerifyResponse>> verifier = _ =>
            Task.FromResult(CreateValidVerifyResponse());

        facilitator.RegisterSchemeVerifier("evm-exact", verifier);

        var hooks = new TestFacilitatorHooks
        {
            BeforeVerifyAction = ctx =>
            {
                ctx.ShouldAbort = true;
                return Task.CompletedTask;
            }
        };

        facilitator.RegisterHooks(hooks);

        var ex = await Assert.ThrowsAsync<VerifyError>(
            () => facilitator.VerifyAsync(payload)
        );

        Assert.Equal("ABORTED_BY_HOOK", ex.InvalidReason);
    }

    [Fact]
    public async Task AfterVerifyAsync_Hook_IsInvoked()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();
        var hookInvoked = false;

        Func<PaymentPayload, Task<VerifyResponse>> verifier = _ =>
            Task.FromResult(CreateValidVerifyResponse());

        facilitator.RegisterSchemeVerifier("evm-exact", verifier);

        var hooks = new TestFacilitatorHooks
        {
            AfterVerifyAction = ctx =>
            {
                hookInvoked = true;
                Assert.NotNull(ctx.VerifyResponse);
                return Task.CompletedTask;
            }
        };

        facilitator.RegisterHooks(hooks);
        await facilitator.VerifyAsync(payload);

        Assert.True(hookInvoked);
    }

    [Fact]
    public async Task BeforeSettleAsync_Hook_CanAbort()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();

        Func<PaymentPayload, Task<SettleResponse>> settler = _ =>
            Task.FromResult(CreateValidSettleResponse());

        facilitator.RegisterSchemeSettler("evm-exact", settler);

        var hooks = new TestFacilitatorHooks
        {
            BeforeSettleAction = ctx =>
            {
                ctx.ShouldAbort = true;
                return Task.CompletedTask;
            }
        };

        facilitator.RegisterHooks(hooks);

        var ex = await Assert.ThrowsAsync<SettleError>(
            () => facilitator.SettleAsync(payload)
        );

        Assert.Equal("ABORTED_BY_HOOK", ex.ErrorReason);
    }

    [Fact]
    public async Task AfterSettleAsync_Hook_IsInvoked()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();
        var hookInvoked = false;

        Func<PaymentPayload, Task<SettleResponse>> settler = _ =>
            Task.FromResult(CreateValidSettleResponse());

        facilitator.RegisterSchemeSettler("evm-exact", settler);

        var hooks = new TestFacilitatorHooks
        {
            AfterSettleAction = ctx =>
            {
                hookInvoked = true;
                Assert.NotNull(ctx.SettleResponse);
                return Task.CompletedTask;
            }
        };

        facilitator.RegisterHooks(hooks);
        await facilitator.SettleAsync(payload);

        Assert.True(hookInvoked);
    }

    [Fact]
    public async Task OnSettleFailureAsync_Hook_IsInvoked()
    {
        var facilitator = new X402Facilitator();
        var payload = CreateTestPayload();
        var hookInvoked = false;

        Func<PaymentPayload, Task<SettleResponse>> settler = _ =>
            throw new InvalidOperationException("Settlement error");

        facilitator.RegisterSchemeSettler("evm-exact", settler);

        var hooks = new TestFacilitatorHooks
        {
            OnSettleFailureAction = ctx =>
            {
                hookInvoked = true;
                Assert.NotNull(ctx.Error);
                return Task.CompletedTask;
            }
        };

        facilitator.RegisterHooks(hooks);

        await Assert.ThrowsAsync<SettleError>(
            () => facilitator.SettleAsync(payload)
        );

        Assert.True(hookInvoked);
    }

    private class TestFacilitatorHooks : IFacilitatorHooks
    {
        public Func<FacilitatorHookContext, Task>? BeforeVerifyAction { get; set; }
        public Func<FacilitatorHookContext, Task>? AfterVerifyAction { get; set; }
        public Func<FacilitatorHookContext, Task>? OnVerifyFailureAction { get; set; }
        public Func<FacilitatorHookContext, Task>? BeforeSettleAction { get; set; }
        public Func<FacilitatorHookContext, Task>? AfterSettleAction { get; set; }
        public Func<FacilitatorHookContext, Task>? OnSettleFailureAction { get; set; }

        public Task BeforeVerifyAsync(FacilitatorHookContext context) =>
            BeforeVerifyAction?.Invoke(context) ?? Task.CompletedTask;

        public Task AfterVerifyAsync(FacilitatorHookContext context) =>
            AfterVerifyAction?.Invoke(context) ?? Task.CompletedTask;

        public Task OnVerifyFailureAsync(FacilitatorHookContext context) =>
            OnVerifyFailureAction?.Invoke(context) ?? Task.CompletedTask;

        public Task BeforeSettleAsync(FacilitatorHookContext context) =>
            BeforeSettleAction?.Invoke(context) ?? Task.CompletedTask;

        public Task AfterSettleAsync(FacilitatorHookContext context) =>
            AfterSettleAction?.Invoke(context) ?? Task.CompletedTask;

        public Task OnSettleFailureAsync(FacilitatorHookContext context) =>
            OnSettleFailureAction?.Invoke(context) ?? Task.CompletedTask;
    }
}
