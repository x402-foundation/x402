using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Transport.Http;
using X402.Core.Transport.Http.Adapters;
using Xunit;

namespace X402.Core.Tests.Transport.Http;

public class HttpClientTransportTests
{
    private static PaymentRequirements CreateTestRequirements()
    {
        return new PaymentRequirements(
            "evm-exact",
            "eip155:84532",
            "USDC",
            "1000000000000000000",
            "0x1234567890123456789012345678901234567890",
            3600
        );
    }

    private static PaymentPayload CreateTestPayload()
    {
        return new PaymentPayload(
            2,
            CreateTestRequirements(),
            new JsonObject { ["sig"] = "test-signature" }
        );
    }

    [Fact]
    public async Task HandlePaymentRequiredAsync_DecodeHeader_ReturnPayload()
    {
        // Arrange
        var requirements = CreateTestRequirements();
        var paymentRequired = new PaymentRequired(2, [requirements]);
        var base64Header = HeaderCodec.Encode(paymentRequired);

        var mockClient = new X402Client();
        var testPayload = CreateTestPayload();
        mockClient.RegisterSchemeHandler("evm-exact", _ => Task.FromResult(testPayload));

        var transport = new HttpClientTransport(mockClient);

        // Act
        var result = await transport.HandlePaymentRequiredAsync(base64Header);

        // Assert
        Assert.NotNull(result);
        Assert.Equal(2, result.X402Version);
        Assert.Equal("evm-exact", result.Accepted.Scheme);
    }

    [Fact]
    public async Task HandlePaymentRequiredAsync_SelectsSupportedRequirement()
    {
        var paymentRequired = new PaymentRequired(2, [
            CreateTestRequirements() with { Scheme = "svm-exact" },
        CreateTestRequirements()
        ]);
        var base64Header = HeaderCodec.Encode(paymentRequired);

        var mockClient = new X402Client();
        var testPayload = CreateTestPayload();
        mockClient.RegisterSchemeHandler("evm-exact", _ => Task.FromResult(testPayload));

        var transport = new HttpClientTransport(mockClient);

        var result = await transport.HandlePaymentRequiredAsync(base64Header);

        Assert.Equal("evm-exact", result.Accepted.Scheme);
    }

    [Fact]
    public async Task HandlePaymentRequiredAsync_EmptyHeader_ThrowsException()
    {
        // Arrange
        var mockClient = new X402Client();
        var transport = new HttpClientTransport(mockClient);

        // Act & Assert
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => transport.HandlePaymentRequiredAsync("invalid-base64")
        );
    }

    [Fact]
    public async Task SendPaymentAsync_CreatesHttpRequest_ReturnsSuccess()
    {
        // Arrange
        var payload = CreateTestPayload();
        var mockClient = new X402Client();

        var mockHandler = new MockHttpMessageHandler();
        var httpClient = new HttpClient(mockHandler);

        var transport = new HttpClientTransport(mockClient, httpClient);

        // Act
        var result = await transport.SendPaymentAsync(payload, "http://example.com/api/data");

        // Assert
        Assert.True(result);
        Assert.NotNull(mockHandler.LastRequest);
        Assert.True(mockHandler.LastRequest.Headers.Contains(X402HttpHeaders.PaymentSignature));
        Assert.False(mockHandler.LastRequest.Headers.Contains(X402HttpHeaders.PaymentResponse));
    }

    [Fact]
    public async Task SendPaymentAndRetryAsync_IncludesPaymentHeader_ReturnsResponse()
    {
        // Arrange
        var payload = CreateTestPayload();
        var mockClient = new X402Client();

        var mockHandler = new MockHttpMessageHandler();
        var httpClient = new HttpClient(mockHandler);

        var transport = new HttpClientTransport(mockClient, httpClient);

        // Act
        var result = await transport.SendPaymentAndRetryAsync(payload, "http://example.com/api/data");

        // Assert
        Assert.NotNull(result);
        Assert.True(result.IsSuccessStatusCode);
        Assert.NotNull(mockHandler.LastRequest);
        Assert.True(mockHandler.LastRequest.Headers.Contains(X402HttpHeaders.PaymentSignature));
        Assert.False(mockHandler.LastRequest.Headers.Contains(X402HttpHeaders.PaymentResponse));
    }

    private class MockHttpMessageHandler : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK));
        }
    }
}
