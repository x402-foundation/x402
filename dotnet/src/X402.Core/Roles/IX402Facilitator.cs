using X402.Core.Protocol.V2;
using X402.Core.Roles.Hooks;

namespace X402.Core.Roles;

/// <summary>
/// x402 Facilitator role: validates and settles payments on behalf of resource servers.
/// The facilitator role represents an intermediary (payment processor, bridge, relay).
/// </summary>
public interface IX402Facilitator
{
    /// <summary>
    /// Register a scheme handler for verifying payments of a specific scheme.
    /// </summary>
    /// <param name="scheme">Scheme identifier (e.g., "evm-exact")</param>
    /// <param name="verifier">Callback to verify payments for this scheme</param>
    void RegisterSchemeVerifier(string scheme, Func<PaymentPayload, Task<VerifyResponse>> verifier);

    /// <summary>
    /// Register a scheme handler for settling payments of a specific scheme.
    /// </summary>
    /// <param name="scheme">Scheme identifier (e.g., "evm-exact")</param>
    /// <param name="settler">Callback to settle payments for this scheme</param>
    void RegisterSchemeSettler(string scheme, Func<PaymentPayload, Task<SettleResponse>> settler);

    /// <summary>
    /// Register an extension handler to process extension data.
    /// </summary>
    /// <param name="extensionName">Extension identifier (e.g., "bazaar")</param>
    /// <param name="handler">Callback to handle this extension</param>
    void RegisterExtension(string extensionName, Func<Dictionary<string, object?>, Task> handler);

    /// <summary>
    /// Register facilitator-side lifecycle hooks.
    /// </summary>
    void RegisterHooks(IFacilitatorHooks hooks);

    /// <summary>
    /// Verify a payment payload using registered scheme handlers.
    /// </summary>
    /// <param name="payload">Payment payload to verify</param>
    /// <returns>Verification result</returns>
    Task<VerifyResponse> VerifyAsync(PaymentPayload payload);

    /// <summary>
    /// Settle a payment payload using registered scheme handlers.
    /// Performs on-chain transfers, off-chain bookkeeping, or other settlement logic.
    /// </summary>
    /// <param name="payload">Verified payment payload to settle</param>
    /// <returns>Settlement result with transaction identifier</returns>
    Task<SettleResponse> SettleAsync(PaymentPayload payload);
}
