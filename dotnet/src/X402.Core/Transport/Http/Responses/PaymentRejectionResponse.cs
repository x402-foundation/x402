namespace X402.Core.Transport.Http.Responses;

/// <summary>
/// HTTP wrapper for payment rejection response.
/// Server responds with HTTP status indicating payment was rejected.
/// </summary>
public class PaymentRejectionResponse
{
    /// <summary>
    /// Reason for rejection.
    /// </summary>
    public required string Reason { get; init; }

    /// <summary>
    /// HTTP status code (typically 403 Forbidden or 402 Payment Required with retry).
    /// </summary>
    public int StatusCode { get; init; } = 403;

    /// <summary>
    /// Error details for debugging.
    /// </summary>
    public string? ErrorDetails { get; init; }

    /// <summary>
    /// Custom response headers.
    /// </summary>
    public Dictionary<string, string> Headers { get; init; } = [];
}
