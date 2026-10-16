using X402.Core.Protocol.V2;
using X402.Core.Roles.Hooks;

namespace X402.Core.Roles;

/// <summary>
/// x402 ResourceServer role: protects resources and verifies payments.
/// The resource server represents the seller/resource owner in the x402 flow.
/// </summary>
public interface IX402ResourceServer
{
    /// <summary>
    /// Register a scheme handler for verifying payments of a specific scheme.
    /// </summary>
    /// <param name="scheme">Scheme identifier (e.g., "evm-exact")</param>
    /// <param name="verifier">Callback to verify payments for this scheme</param>
    void RegisterSchemeVerifier(string scheme, Func<PaymentPayload, Task<VerifyResponse>> verifier);

    /// <summary>
    /// Register a scheme that should delegate verification and settlement to the configured facilitator client.
    /// </summary>
    /// <param name="scheme">Scheme identifier (e.g., "evm-exact")</param>
    void RegisterFacilitatedScheme(string scheme);

    /// <summary>
    /// Initialize the resource server with payment requirements for a protected resource.
    /// </summary>
    /// <param name="resourcePath">Path or identifier for the protected resource</param>
    /// <param name="requirements">Payment requirements to enforce</param>
    void Initialize(string resourcePath, PaymentRequirements requirements);

    /// <summary>
    /// Register server-side lifecycle hooks.
    /// </summary>
    void RegisterHooks(IServerHooks hooks);

    /// <summary>
    /// Verify a payment payload against registered handlers.
    /// </summary>
    /// <param name="payload">Payment payload from client</param>
    /// <param name="facilitatorUrl">Optional facilitator URL override for this verification request</param>
    /// <returns>Verification result</returns>
    Task<VerifyResponse> VerifyPaymentAsync(PaymentPayload payload, string? facilitatorUrl = null);

    /// <summary>
    /// Settle a payment (deduct/transfer funds after verification).
    /// May coordinate with facilitator for settlement.
    /// </summary>
    /// <param name="payload">Verified payment payload</param>
    /// <param name="facilitatorUrl">Optional facilitator URL override for this settlement request</param>
    /// <returns>Settlement response</returns>
    Task<SettleResponse> SettlePaymentAsync(PaymentPayload payload, string? facilitatorUrl = null);

    /// <summary>
    /// Get payment requirements for a protected resource.
    /// </summary>
    /// <param name="resourcePath">Path or identifier for the resource</param>
    /// <returns>Payment requirements for that resource</returns>
    Task<PaymentRequirements?> GetRequirementsAsync(string resourcePath);
}
