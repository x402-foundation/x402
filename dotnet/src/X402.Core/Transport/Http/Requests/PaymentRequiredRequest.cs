using X402.Core.Protocol.V2;

namespace X402.Core.Transport.Http.Requests;

/// <summary>
/// HTTP wrapper for sending payment requirements to a client.
/// Typically sent with HTTP 402 Payment Required status.
/// </summary>
public class PaymentRequiredRequest
{
    /// <summary>
    /// Payment requirements to present to client.
    /// </summary>
    public required PaymentRequired Requirements { get; init; }

    /// <summary>
    /// Resource URL or path being requested (for context).
    /// </summary>
    public string? ResourcePath { get; init; }

    /// <summary>
    /// HTTP status code to respond with (typically 402).
    /// </summary>
    public int StatusCode { get; init; } = 402;

    /// <summary>
    /// Custom headers to include in response.
    /// </summary>
    public Dictionary<string, string> Headers { get; init; } = [];
}
