using X402.Core.Protocol.V2;
using X402.Core.Roles;

namespace X402.Core.Transport.Http.Adapters;

/// <summary>
/// HTTP facilitator client used by resource servers to delegate verification and settlement.
/// </summary>
public sealed class HttpFacilitatorClient : IX402FacilitatorClient, IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly string? _defaultFacilitatorUrl;

    public HttpFacilitatorClient(HttpClient httpClient, string? defaultFacilitatorUrl = null)
    {
        _httpClient = httpClient;
        _defaultFacilitatorUrl = defaultFacilitatorUrl;
    }

    public async Task<VerifyResponse> VerifyAsync(PaymentPayload payload, string? facilitatorUrl = null)
    {
        var effectiveUrl = ResolveUrl(facilitatorUrl);
        var base64Payload = HeaderCodec.Encode(payload);

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{effectiveUrl}/verify");
        request.Headers.Add(X402HttpHeaders.PaymentResponse, base64Payload);

        using var response = await _httpClient.SendAsync(request);

        if (!response.IsSuccessStatusCode)
            return new VerifyResponse(false, "HTTP verification failed", null);

        if (!response.Headers.TryGetValues(X402HttpHeaders.PaymentSignature, out var headerValues))
            return new VerifyResponse(false, "Missing facilitator response header", null);

        var resultHeader = headerValues.FirstOrDefault();
        return resultHeader is null
            ? new VerifyResponse(false, "Empty facilitator response", null)
            : HeaderCodec.Decode<VerifyResponse>(resultHeader);
    }

    public async Task<SettleResponse> SettleAsync(PaymentPayload payload, string? facilitatorUrl = null)
    {
        var effectiveUrl = ResolveUrl(facilitatorUrl);
        var base64Payload = HeaderCodec.Encode(payload);

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{effectiveUrl}/settle");
        request.Headers.Add(X402HttpHeaders.PaymentResponse, base64Payload);

        using var response = await _httpClient.SendAsync(request);

        if (!response.IsSuccessStatusCode)
            return new SettleResponse(false, string.Empty, string.Empty, "HTTP settlement failed");

        if (!response.Headers.TryGetValues(X402HttpHeaders.PaymentResponse, out var headerValues))
            return new SettleResponse(false, string.Empty, string.Empty, "Missing facilitator response header");

        var resultHeader = headerValues.FirstOrDefault();
        return resultHeader is null
            ? new SettleResponse(false, string.Empty, string.Empty, "Empty facilitator response")
            : HeaderCodec.Decode<SettleResponse>(resultHeader);
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }

    private string ResolveUrl(string? facilitatorUrl)
    {
        var effectiveUrl = facilitatorUrl ?? _defaultFacilitatorUrl;
        if (string.IsNullOrWhiteSpace(effectiveUrl))
            throw new InvalidOperationException("A facilitator URL is required for external verification.");

        return effectiveUrl.TrimEnd('/');
    }
}