using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using X402.AspNetCore;
using X402.Core.Protocol.V2;
using X402.Core.Roles;

namespace X402.AspNetCore.Tests;

public class X402ServiceExtensionsTests
{
    [Fact]
    public async Task AddX402_FacilitatedScheme_UsesConfiguredFacilitatorClient()
    {
        var facilitatorClient = new FakeFacilitatorClient();
        var services = new ServiceCollection();

        services.AddX402(options =>
        {
            options
            .UseFacilitatorClient(facilitatorClient, "https://facilitator.example.com")
            .RegisterFacilitatedScheme("evm-exact");
        });

        using var provider = services.BuildServiceProvider();
        var server = provider.GetRequiredService<IX402ResourceServer>();

        var result = await server.VerifyPaymentAsync(new PaymentPayload(
            2,
            new PaymentRequirements("evm-exact", "eip155:84532", "0xtoken", "10000", "0xrecipient", 60, null),
            new JsonObject { ["signature"] = "0xdeadbeef" },
            null,
            null));

        Assert.True(result.IsValid);
        Assert.Equal("https://facilitator.example.com", facilitatorClient.LastVerifyUrl);
    }

    [Fact]
    public void AddX402_FacilitatedSchemeWithoutClient_Throws()
    {
        var services = new ServiceCollection();

        var ex = Assert.Throws<InvalidOperationException>(() =>
            services.AddX402(options => options.RegisterFacilitatedScheme("evm-exact")));

        Assert.Contains("Facilitated schemes require a facilitator client", ex.Message);
    }

    private sealed class FakeFacilitatorClient : IX402FacilitatorClient
    {
        public string? LastVerifyUrl { get; private set; }

        public Task<VerifyResponse> VerifyAsync(PaymentPayload payload, string? facilitatorUrl = null)
        {
            LastVerifyUrl = facilitatorUrl;
            return Task.FromResult(new VerifyResponse(true, null, "0xpayer"));
        }

        public Task<SettleResponse> SettleAsync(PaymentPayload payload, string? facilitatorUrl = null) =>
            Task.FromResult(new SettleResponse(true, "0xtx", "eip155:84532", null, "0xpayer", payload.Accepted.Amount));
    }
}