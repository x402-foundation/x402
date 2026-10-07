using X402.Core.Protocol.V2;

namespace X402.Core.Transport.Http.Responses;

/// <summary>
/// HTTP wrapper for successful payment response.
/// Client responds with HTTP 200 and includes payment payload in header or body.
/// </summary>
public class PaymentSuccessResponse
{
    /// <summary>
    /// The accepted payment payload.
    /// </summary>
    public required PaymentPayload Payload { get; init; }

    /// <summary>
    /// HTTP status code (typically 200).
    /// </summary>
    public int StatusCode { get; init; } = 200;

    /// <summary>
    /// Custom response headers.
    /// </summary>
    public Dictionary<string, string> Headers { get; init; } = [];
}
