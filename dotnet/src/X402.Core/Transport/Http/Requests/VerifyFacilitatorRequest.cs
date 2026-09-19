using X402.Core.Protocol.V2;

namespace X402.Core.Transport.Http.Requests;

/// <summary>
/// HTTP wrapper for verify request sent by server to facilitator.
/// </summary>
public class VerifyFacilitatorRequest
{
    /// <summary>
    /// The payment payload to verify.
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
