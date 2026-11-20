using X402.Core.Protocol.V2;

namespace X402.Core.Transport.Http.Requests;

/// <summary>
/// HTTP wrapper for payment payload submission from client.
/// Typically sent as form data or in a custom header with the payment payload.
/// </summary>
public class PaymentPayloadRequest
{
    /// <summary>
    /// The signed payment payload from client.
    /// </summary>
    public required PaymentPayload Payload { get; init; }

    /// <summary>
    /// HTTP method for this request (typically POST or PUT).
    /// </summary>
    public string HttpMethod { get; init; } = "POST";

    /// <summary>
    /// Optional custom headers to include.
    /// </summary>
    public Dictionary<string, string> Headers { get; init; } = [];
}
