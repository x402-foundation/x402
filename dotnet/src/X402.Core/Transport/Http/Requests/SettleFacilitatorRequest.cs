using X402.Core.Protocol.V2;

namespace X402.Core.Transport.Http.Requests;

/// <summary>
/// HTTP wrapper for settle request sent by client or server to facilitator.
/// </summary>
public class SettleFacilitatorRequest
{
    /// <summary>
    /// The payment payload to settle.
    /// </summary>
    public required PaymentPayload Payload { get; init; }

    /// <summary>
    /// Facilitator endpoint URL.
    /// </summary>
    public required string FacilitatorUrl { get; init; }

    /// <summary>
    /// Optional custom headers for authenticating with facilitator.
    /// </summary>
    public Dictionary<string, string> Headers { get; init; } = [];
}
