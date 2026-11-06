using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Roles.Errors;
using X402.Core.Transport.Http;
using X402.Core.Transport.Http.Adapters;
using X402.Core.Transport.Http.Responses;
using Xunit;

namespace X402.Core.Tests.Transport.Http;

public class HttpFacilitatorTransportTests
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
    public async Task HandleVerifyRequestAsync_ValidPayload_ReturnsVerifyResponse()
    {
        // Arrange
        var payload = CreateTestPayload();
        var facilitator = new X402Facilitator();

        // Register verifier that always accepts
        Func<PaymentPayload, Task<VerifyResponse>> verifier = p =>
            Task.FromResult(new VerifyResponse(true, null, "0xpayer"));
        facilitator.RegisterSchemeVerifier("evm-exact", verifier);

        var base64Payload = HeaderCodec.Encode(payload);
        var transport = new HttpFacilitatorTransport(facilitator);

        // Act
        var result = await transport.HandleVerifyRequestAsync(base64Payload);

        // Assert
        Assert.NotNull(result);
        Assert.Equal(200, result.StatusCode);
        Assert.True(result.Result.IsValid);
    }

    [Fact]
    public async Task HandleVerifyRequestAsync_InvalidPayload_ReturnsFailure()
    {
        // Arrange
        var facilitator = new X402Facilitator();
        var transport = new HttpFacilitatorTransport(facilitator);

        // Act
        var result = await transport.HandleVerifyRequestAsync("invalid-base64");

        // Assert
        Assert.NotNull(result);
        Assert.Equal(500, result.StatusCode); // Exception handling returns 500
        Assert.False(result.Result.IsValid);
    }

    [Fact]
    public async Task HandleVerifyRequestAsync_VerificationFails_ReturnsFailure()
    {
        // Arrange
        var payload = CreateTestPayload();
        var facilitator = new X402Facilitator();

        // Register verifier that rejects
        Func<PaymentPayload, Task<VerifyResponse>> verifier = p =>
            Task.FromResult(new VerifyResponse(false, "INVALID_SIGNATURE", null));
        facilitator.RegisterSchemeVerifier("evm-exact", verifier);

        var base64Payload = HeaderCodec.Encode(payload);
        var transport = new HttpFacilitatorTransport(facilitator);

        // Act
        var result = await transport.HandleVerifyRequestAsync(base64Payload);

        // Assert
        Assert.NotNull(result);
        Assert.False(result.Result.IsValid);
    }

    [Fact]
    public async Task HandleSettleRequestAsync_ValidPayload_ReturnsSettleResponse()
    {
        // Arrange
        var payload = CreateTestPayload();
        var facilitator = new X402Facilitator();

        // Register settler that succeeds
        Func<PaymentPayload, Task<SettleResponse>> settler = p =>
            Task.FromResult(new SettleResponse(
                true,
                "0xtxhash",
                "eip155:84532",
                null,
                "0xpayer",
                "1000000000000000000"
            ));
        facilitator.RegisterSchemeSettler("evm-exact", settler);

        var base64Payload = HeaderCodec.Encode(payload);
        var transport = new HttpFacilitatorTransport(facilitator);

        // Act
        var result = await transport.HandleSettleRequestAsync(base64Payload);

        // Assert
        Assert.NotNull(result);
        Assert.Equal(200, result.StatusCode);
        Assert.True(result.Result.Success);
        Assert.Equal("0xtxhash", result.Result.Transaction);
    }

    [Fact]
    public async Task HandleSettleRequestAsync_InvalidPayload_ReturnsFailure()
    {
        // Arrange
        var facilitator = new X402Facilitator();
        var transport = new HttpFacilitatorTransport(facilitator);

        // Act
        var result = await transport.HandleSettleRequestAsync("invalid-base64");

        // Assert
        Assert.NotNull(result);
        Assert.Equal(500, result.StatusCode); // Exception handling returns 500
        Assert.False(result.Result.Success);
    }

    [Fact]
    public async Task HandleSettleRequestAsync_SettlementFails_ReturnsFailure()
    {
        // Arrange
        var payload = CreateTestPayload();
        var facilitator = new X402Facilitator();

        // Register settler that fails
        Func<PaymentPayload, Task<SettleResponse>> settler = p =>
            Task.FromResult(new SettleResponse(
                false,
                "",
                "",
                "INSUFFICIENT_BALANCE"
            ));
        facilitator.RegisterSchemeSettler("evm-exact", settler);

        var base64Payload = HeaderCodec.Encode(payload);
        var transport = new HttpFacilitatorTransport(facilitator);

        // Act
        var result = await transport.HandleSettleRequestAsync(base64Payload);

        // Assert
        Assert.NotNull(result);
        Assert.False(result.Result.Success);
    }

    [Fact]
    public async Task VerifyViaHttpAsync_ValidPayload_ReturnsVerifyResponse()
    {
        // Arrange
        var payload = CreateTestPayload();
        var facilitator = new X402Facilitator();

        Func<PaymentPayload, Task<VerifyResponse>> verifier = p =>
            Task.FromResult(new VerifyResponse(true, null, "0xpayer"));
        facilitator.RegisterSchemeVerifier("evm-exact", verifier);

        var mockHandler = new MockHttpMessageHandler();
        var httpClient = new HttpClient(mockHandler);
        var transport = new HttpFacilitatorTransport(facilitator, httpClient);

        // Act
        var result = await transport.VerifyViaHttpAsync(payload, "http://localhost:8000");

        // Assert
        Assert.NotNull(result);
        Assert.True(result.IsValid);
    }

    [Fact]
    public async Task SettleViaHttpAsync_ValidPayload_ReturnsSettleResponse()
    {
        // Arrange
        var payload = CreateTestPayload();
        var facilitator = new X402Facilitator();

        Func<PaymentPayload, Task<SettleResponse>> settler = p =>
            Task.FromResult(new SettleResponse(
                true,
                "0xtxhash",
                "eip155:84532",
                null,
                "0xpayer",
                "1000000000000000000"
            ));
        facilitator.RegisterSchemeSettler("evm-exact", settler);

        var mockHandler = new MockHttpMessageHandler();
        var httpClient = new HttpClient(mockHandler);
        var transport = new HttpFacilitatorTransport(facilitator, httpClient);

        // Act
        var result = await transport.SettleViaHttpAsync(payload, "http://localhost:8000");

        // Assert
        Assert.NotNull(result);
        Assert.True(result.Success);
    }

    private class MockHttpMessageHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            // Return successful response with mocked headers
            var response = new HttpResponseMessage(System.Net.HttpStatusCode.OK);

            // Add default response headers for verify/settle operations
            var verifyResponse = new VerifyResponse(true, null, "0xpayer");
            var settleResponse = new SettleResponse(
                true,
                "0xtxhash",
                "eip155:84532",
                null,
                "0xpayer",
                "1000000000000000000"
            );

            // Check if this is a verify or settle request based on URL
            if (request.RequestUri?.PathAndQuery.Contains("/verify") ?? false)
            {
                response.Headers.Add(X402HttpHeaders.PaymentSignature, HeaderCodec.Encode(verifyResponse));
            }
            else if (request.RequestUri?.PathAndQuery.Contains("/settle") ?? false)
            {
                response.Headers.Add(X402HttpHeaders.PaymentResponse, HeaderCodec.Encode(settleResponse));
            }

            return Task.FromResult(response);
        }
    }
}
