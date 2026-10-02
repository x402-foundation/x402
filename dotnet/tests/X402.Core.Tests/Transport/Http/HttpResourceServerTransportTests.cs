using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Roles.Errors;
using X402.Core.Transport.Http;
using X402.Core.Transport.Http.Adapters;
using X402.Core.Transport.Http.Responses;
using Xunit;

namespace X402.Core.Tests.Transport.Http;

public class HttpResourceServerTransportTests
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
    public async Task GeneratePaymentRequiredAsync_ReturnsPaymentRequiredRequest()
    {
        // Arrange
        var server = new X402ResourceServer();
        var requirements = CreateTestRequirements();
        server.Initialize("/api/data", requirements);

        var transport = new HttpResourceServerTransport(server);

        // Act
        var result = await transport.GeneratePaymentRequiredAsync("/api/data");

        // Assert
        Assert.NotNull(result);
        Assert.Equal(402, result.StatusCode);
        Assert.Equal("/api/data", result.ResourcePath);
        Assert.NotNull(result.Requirements);
        Assert.Equal(2, result.Requirements.X402Version);
    }

    [Fact]
    public async Task GeneratePaymentRequiredAsync_UnknownPath_ThrowsException()
    {
        // Arrange
        var server = new X402ResourceServer();
        var transport = new HttpResourceServerTransport(server);

        // Act & Assert
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => transport.GeneratePaymentRequiredAsync("/unknown")
        );
    }

    [Fact]
    public async Task ProcessPaymentAsync_ValidPayload_ReturnsSuccessResponse()
    {
        // Arrange
        var payload = CreateTestPayload();
        var server = new X402ResourceServer();
        server.Initialize("/api/data", CreateTestRequirements());

        // Register a verifier that always accepts
        Func<PaymentPayload, Task<VerifyResponse>> verifier = p =>
            Task.FromResult(new VerifyResponse(true, null, "0xpayer"));
        server.RegisterSchemeVerifier("evm-exact", verifier);

        var base64Payload = HeaderCodec.Encode(payload);
        var transport = new HttpResourceServerTransport(server);

        // Act
        var result = await transport.ProcessPaymentAsync(base64Payload);

        // Assert
        Assert.IsType<PaymentSuccessResponse>(result);
        var successResponse = (PaymentSuccessResponse)result;
        Assert.Equal(200, successResponse.StatusCode);
        Assert.NotNull(successResponse.Payload);
    }

    [Fact]
    public async Task ProcessPaymentAsync_InvalidPayload_ReturnsRejectionResponse()
    {
        // Arrange
        var server = new X402ResourceServer();
        var transport = new HttpResourceServerTransport(server);

        // Act
        var result = await transport.ProcessPaymentAsync("invalid-base64");

        // Assert
        Assert.IsType<PaymentRejectionResponse>(result);
        var rejectionResponse = (PaymentRejectionResponse)result;
        Assert.Equal(500, rejectionResponse.StatusCode); // Exception handling returns 500
    }

    [Fact]
    public async Task ProcessPaymentAsync_VerificationFails_ReturnsRejectionResponse()
    {
        // Arrange
        var payload = CreateTestPayload();
        var server = new X402ResourceServer();
        server.Initialize("/api/data", CreateTestRequirements());

        // Register a verifier that rejects
        Func<PaymentPayload, Task<VerifyResponse>> verifier = p =>
            Task.FromResult(new VerifyResponse(false, "INSUFFICIENT_AMOUNT", null));
        server.RegisterSchemeVerifier("evm-exact", verifier);

        var base64Payload = HeaderCodec.Encode(payload);
        var transport = new HttpResourceServerTransport(server);

        // Act
        var result = await transport.ProcessPaymentAsync(base64Payload);

        // Assert
        Assert.IsType<PaymentRejectionResponse>(result);
        var rejectionResponse = (PaymentRejectionResponse)result;
        Assert.Equal(403, rejectionResponse.StatusCode);
        Assert.Contains("INSUFFICIENT_AMOUNT", rejectionResponse.Reason);
    }

    [Fact]
    public async Task GetRequirementsAsync_ReturnsStoredRequirements()
    {
        // Arrange
        var server = new X402ResourceServer();
        var requirements = CreateTestRequirements();
        server.Initialize("/api/data", requirements);

        var transport = new HttpResourceServerTransport(server);

        // Act
        var result = await transport.GetRequirementsAsync("/api/data");

        // Assert
        Assert.NotNull(result);
        Assert.Equal(requirements, result);
    }

    [Fact]
    public async Task GetRequirementsAsync_UnknownPath_ReturnsNull()
    {
        // Arrange
        var server = new X402ResourceServer();
        var transport = new HttpResourceServerTransport(server);

        // Act
        var result = await transport.GetRequirementsAsync("/unknown");

        // Assert
        Assert.Null(result);
    }
}
