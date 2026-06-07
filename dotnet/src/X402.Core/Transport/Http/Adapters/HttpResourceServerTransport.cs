using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Roles.Errors;
using X402.Core.Transport.Http.Requests;
using X402.Core.Transport.Http.Responses;

namespace X402.Core.Transport.Http.Adapters;

/// <summary>
/// HTTP transport adapter for x402 ResourceServer role.
/// Handles receiving payments via HTTP and protecting resources.
/// </summary>
public class HttpResourceServerTransport
{
    private readonly IX402ResourceServer _server;

    public HttpResourceServerTransport(IX402ResourceServer server)
    {
        _server = server;
    }

    /// <summary>
    /// Generate a 402 Payment Required response for a protected resource.
    /// </summary>
    /// <param name="resourcePath">Path of the protected resource</param>
    /// <returns>PaymentRequiredRequest to send to client</returns>
    public async Task<PaymentRequiredRequest> GeneratePaymentRequiredAsync(string resourcePath)
    {
        try
        {
            var requirements = await _server.GetRequirementsAsync(resourcePath);
            if (requirements == null)
            {
                throw new InvalidOperationException($"No payment requirements for resource: {resourcePath}");
            }

            // Create PaymentRequired with accepted options
            var paymentRequired = new PaymentRequired(
                2,
                [requirements]
            );

            return new PaymentRequiredRequest
            {
                Requirements = paymentRequired,
                ResourcePath = resourcePath,
                StatusCode = 402,
                Headers = new Dictionary<string, string>
                {
                    { X402HttpHeaders.PaymentRequired, HeaderCodec.Encode(paymentRequired) }
                }
            };
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Failed to generate payment required response", ex);
        }
    }

    /// <summary>
    /// Process a received payment payload from client.
    /// </summary>
    /// <param name="base64Payload">Base64-encoded PaymentPayload from x402-Payment-Response header</param>
    /// <returns>Success response if payment valid, rejection if invalid</returns>
    public async Task<object> ProcessPaymentAsync(string base64Payload)
    {
        try
        {
            // Decode the payment payload from header
            var payload = HeaderCodec.Decode<PaymentPayload>(base64Payload);
            if (payload == null)
            {
                return new PaymentRejectionResponse
                {
                    Reason = "Invalid payment payload",
                    StatusCode = 400,
                    ErrorDetails = "Could not decode payment payload from header"
                };
            }

            // Verify the payment using registered verifiers
            var verifyResult = await _server.VerifyPaymentAsync(payload);

            if (!verifyResult.IsValid)
            {
                return new PaymentRejectionResponse
                {
                    Reason = verifyResult.InvalidReason ?? "Payment verification failed",
                    StatusCode = 403,
                    ErrorDetails = "Payment did not pass verification"
                };
            }

            // Payment is valid - can proceed to settle if needed
            return new PaymentSuccessResponse
            {
                Payload = payload,
                StatusCode = 200,
                Headers = new Dictionary<string, string>()
            };
        }
        catch (VerifyError verifyEx)
        {
            return new PaymentRejectionResponse
            {
                Reason = verifyEx.InvalidReason ?? "Verification error",
                StatusCode = 403,
                ErrorDetails = verifyEx.Message
            };
        }
        catch (Exception ex)
        {
            return new PaymentRejectionResponse
            {
                Reason = "Payment processing failed",
                StatusCode = 500,
                ErrorDetails = ex.Message
            };
        }
    }

    /// <summary>
    /// Get payment requirements for a resource (for informational requests).
    /// </summary>
    /// <param name="resourcePath">Path of the resource</param>
    /// <returns>Payment requirements or null if resource not found</returns>
    public async Task<PaymentRequirements?> GetRequirementsAsync(string resourcePath)
    {
        return await _server.GetRequirementsAsync(resourcePath);
    }
}
