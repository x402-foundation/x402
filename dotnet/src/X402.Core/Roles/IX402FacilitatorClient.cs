using X402.Core.Protocol.V2;

namespace X402.Core.Roles;

/// <summary>
/// Client abstraction for delegating verification and settlement to an external facilitator.
/// </summary>
public interface IX402FacilitatorClient
{
    /// <summary>
    /// Verify a payment payload using an external facilitator.
    /// </summary>
    Task<VerifyResponse> VerifyAsync(PaymentPayload payload, string? facilitatorUrl = null);

    /// <summary>
    /// Settle a payment payload using an external facilitator.
    /// </summary>
    Task<SettleResponse> SettleAsync(PaymentPayload payload, string? facilitatorUrl = null);
}