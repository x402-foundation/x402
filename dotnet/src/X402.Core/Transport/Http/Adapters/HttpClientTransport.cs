using System.Text;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Transport.Http.Requests;
using X402.Core.Transport.Http.Responses;

namespace X402.Core.Transport.Http.Adapters;

/// <summary>
/// HTTP transport adapter for x402 Client role.
/// Handles sending payment payloads via HTTP and parsing server responses.
/// </summary>
public class HttpClientTransport : IDisposable
{
    private readonly IX402Client _client;
    private readonly HttpClient _httpClient;
    private readonly bool _ownsHttpClient;

    public HttpClientTransport(IX402Client client, HttpClient? httpClient = null)
    {
        _client = client;
        _ownsHttpClient = httpClient is null;
        _httpClient = httpClient ?? new HttpClient();
    }

    /// <summary>
    /// Handle a 402 Payment Required response from a server.
    /// Extracts payment requirements from HTTP header and creates a payment payload.
    /// </summary>
    /// <param name="base64Header">Base64-encoded PaymentRequired from x402-Payment-Required header</param>
    /// <returns>PaymentPayload ready to send to server</returns>
    public async Task<PaymentPayload> HandlePaymentRequiredAsync(string base64Header)
    {
        try
        {
            // Decode header to get PaymentRequired
            var paymentRequired = HeaderCodec.Decode<PaymentRequired>(base64Header);
            if (paymentRequired?.Accepts == null || paymentRequired.Accepts.Count == 0)
            {
                throw new InvalidOperationException("No payment requirements found in header");
            }

            // Delegate option selection to the client.
            var payload = await _client.CreatePaymentPayloadAsync(paymentRequired.Accepts);

            return payload;
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Failed to handle 402 response", ex);
        }
    }

    /// <summary>
    /// Send a payment payload to a server.
    /// </summary>
    /// <param name="payload">Payment payload to send</param>
    /// <param name="resourceUrl">URL of protected resource</param>
    /// <returns>Success if payment accepted</returns>
    public async Task<bool> SendPaymentAsync(PaymentPayload payload, string resourceUrl)
    {
        try
        {
            // Encode payload into base64 header
            var base64Payload = HeaderCodec.Encode(payload);

            // Create HTTP request with payload in header
            using var request = new HttpRequestMessage(HttpMethod.Post, resourceUrl);
            request.Headers.Add(X402HttpHeaders.PaymentSignature, base64Payload);

            // Send request
            using var response = await _httpClient.SendAsync(request);

            // Check if payment was accepted
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Failed to send payment", ex);
        }
    }

    /// <summary>
    /// Send a payment payload and retry the original request.
    /// </summary>
    /// <param name="payload">Payment payload to send</param>
    /// <param name="resourceUrl">URL of protected resource</param>
    /// <returns>Response from server after payment</returns>
    public async Task<HttpResponseMessage> SendPaymentAndRetryAsync(PaymentPayload payload, string resourceUrl)
    {
        try
        {
            // First send payment to notify server
            await SendPaymentAsync(payload, resourceUrl);

            // Then retry the original request with payment header
            var base64Payload = HeaderCodec.Encode(payload);

            using var request = new HttpRequestMessage(HttpMethod.Get, resourceUrl);
            request.Headers.Add(X402HttpHeaders.PaymentSignature, base64Payload);

            var response = await _httpClient.SendAsync(request);
            return response;
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Failed to send payment and retry", ex);
        }
    }

    /// <summary>
    /// Dispose the HTTP client if it was created internally.
    /// </summary>
    public void Dispose()
    {
        if (_ownsHttpClient)
        {
            _httpClient.Dispose();
        }
    }
}
