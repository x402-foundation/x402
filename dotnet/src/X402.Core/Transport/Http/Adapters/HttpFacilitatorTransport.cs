using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Roles.Errors;
using X402.Core.Transport.Http.Requests;
using X402.Core.Transport.Http.Responses;

namespace X402.Core.Transport.Http.Adapters;

/// <summary>
/// HTTP transport adapter for x402 Facilitator role.
/// Handles verify and settle requests from servers/clients via HTTP.
/// </summary>
public class HttpFacilitatorTransport
{
    private readonly IX402Facilitator _facilitator;
    private readonly HttpClient _httpClient;

    public HttpFacilitatorTransport(IX402Facilitator facilitator, HttpClient? httpClient = null)
    {
        _facilitator = facilitator;
        _httpClient = httpClient ?? new HttpClient();
    }

    /// <summary>
    /// Handle a verify request from a server.
    /// Decodes payload and returns verification result.
    /// </summary>
    /// <param name="base64Payload">Base64-encoded PaymentPayload</param>
    /// <returns>Verification result</returns>
    public async Task<FacilitatorVerifyResponse> HandleVerifyRequestAsync(string base64Payload)
    {
        try
        {
            // Decode payload
            var payload = HeaderCodec.Decode<PaymentPayload>(base64Payload);
            if (payload == null)
            {
                return new FacilitatorVerifyResponse
                {
                    Result = new VerifyResponse(false, "Invalid payload format", null),
                    StatusCode = 400
                };
            }

            // Verify using facilitator
            var result = await _facilitator.VerifyAsync(payload);

            return new FacilitatorVerifyResponse
            {
                Result = result,
                StatusCode = 200,
                Headers = new Dictionary<string, string>
                {
                    { X402HttpHeaders.PaymentSignature, HeaderCodec.Encode(result) }
                }
            };
        }
        catch (VerifyError verifyEx)
        {
            return new FacilitatorVerifyResponse
            {
                Result = new VerifyResponse(false, verifyEx.InvalidReason, null),
                StatusCode = 400
            };
        }
        catch (Exception)
        {
            return new FacilitatorVerifyResponse
            {
                Result = new VerifyResponse(false, "Verification failed", null),
                StatusCode = 500
            };
        }
    }

    /// <summary>
    /// Handle a settle request from a client or server.
    /// Processes payment settlement and returns transaction details.
    /// </summary>
    /// <param name="base64Payload">Base64-encoded PaymentPayload</param>
    /// <returns>Settlement result</returns>
    public async Task<FacilitatorSettleResponse> HandleSettleRequestAsync(string base64Payload)
    {
        try
        {
            // Decode payload
            var payload = HeaderCodec.Decode<PaymentPayload>(base64Payload);
            if (payload == null)
            {
                return new FacilitatorSettleResponse
                {
                    Result = new SettleResponse(
                        false,
                        "",
                        "",
                        "Invalid payload format"
                    ),
                    StatusCode = 400
                };
            }

            // Settle using facilitator
            var result = await _facilitator.SettleAsync(payload);

            return new FacilitatorSettleResponse
            {
                Result = result,
                StatusCode = 200,
                Headers = new Dictionary<string, string>
                {
                    { X402HttpHeaders.PaymentResponse, HeaderCodec.Encode(result) }
                }
            };
        }
        catch (SettleError settleEx)
        {
            return new FacilitatorSettleResponse
            {
                Result = new SettleResponse(
                    false,
                    "",
                    "",
                    settleEx.ErrorReason
                ),
                StatusCode = 400
            };
        }
        catch (Exception)
        {
            return new FacilitatorSettleResponse
            {
                Result = new SettleResponse(
                    false,
                    "",
                    "",
                    "Settlement failed"
                ),
                StatusCode = 500
            };
        }
    }

    /// <summary>
    /// Verify a payment via HTTP call to this facilitator.
    /// </summary>
    /// <param name="payload">Payment payload to verify</param>
    /// <param name="facilitatorUrl">URL of facilitator's verify endpoint</param>
    /// <returns>Verification result from HTTP response</returns>
    public async Task<VerifyResponse> VerifyViaHttpAsync(PaymentPayload payload, string facilitatorUrl)
    {
        try
        {
            var base64Payload = HeaderCodec.Encode(payload);

            using var request = new HttpRequestMessage(HttpMethod.Post, $"{facilitatorUrl}/verify");
            request.Headers.Add(X402HttpHeaders.PaymentResponse, base64Payload);

            using var response = await _httpClient.SendAsync(request);

            if (response.IsSuccessStatusCode && response.Headers.TryGetValues(X402HttpHeaders.PaymentSignature, out var headerValues))
            {
                var resultHeader = headerValues.FirstOrDefault();
                if (resultHeader != null)
                {
                    var result = HeaderCodec.Decode<VerifyResponse>(resultHeader);
                    return result ?? new VerifyResponse(false, "Empty response", null);
                }
            }

            return new VerifyResponse(false, "HTTP verification failed", null);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Failed to verify via HTTP", ex);
        }
    }

    /// <summary>
    /// Settle a payment via HTTP call to this facilitator.
    /// </summary>
    /// <param name="payload">Payment payload to settle</param>
    /// <param name="facilitatorUrl">URL of facilitator's settle endpoint</param>
    /// <returns>Settlement result from HTTP response</returns>
    public async Task<SettleResponse> SettleViaHttpAsync(PaymentPayload payload, string facilitatorUrl)
    {
        try
        {
            var base64Payload = HeaderCodec.Encode(payload);

            using var request = new HttpRequestMessage(HttpMethod.Post, $"{facilitatorUrl}/settle");
            request.Headers.Add(X402HttpHeaders.PaymentResponse, base64Payload);

            using var response = await _httpClient.SendAsync(request);

            if (response.IsSuccessStatusCode && response.Headers.TryGetValues(X402HttpHeaders.PaymentResponse, out var headerValues))
            {
                var resultHeader = headerValues.FirstOrDefault();
                if (resultHeader != null)
                {
                    var result = HeaderCodec.Decode<SettleResponse>(resultHeader);
                    return result ?? new SettleResponse(false, "", "", "No response content");
                }
            }

            return new SettleResponse(false, "", "", "HTTP settlement failed");
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Failed to settle via HTTP", ex);
        }
    }

    /// <summary>
    /// Dispose the HTTP client if created internally.
    /// </summary>
    public void Dispose()
    {
        _httpClient?.Dispose();
    }
}
