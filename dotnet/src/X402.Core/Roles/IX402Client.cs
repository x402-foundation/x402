using X402.Core.Protocol.V2;
using X402.Core.Roles.Hooks;

namespace X402.Core.Roles;

/// <summary>
/// x402 Client role: creates payment payloads and initiates transactions.
/// The client role represents the payer/buyer in the x402 flow.
/// </summary>
public interface IX402Client
{
    /// <summary>
    /// Register a scheme handler for creating payments of a specific scheme type.
    /// </summary>
    /// <param name="scheme">Scheme identifier (e.g., "evm-exact")</param>
    /// <param name="handler">Callback to create payment payload for this scheme</param>
    void RegisterSchemeHandler(string scheme, Func<PaymentRequirements, Task<PaymentPayload>> handler);

    /// <summary>
    /// Register a payment policy that can enforce constraints across scheme handlers.
    /// </summary>
    /// <param name="policyName">Policy identifier</param>
    /// <param name="policy">Policy validator callback</param>
    void RegisterPolicy(string policyName, Func<PaymentPayload, Task<bool>> policy);

    /// <summary>
    /// Register client-side lifecycle hooks.
    /// </summary>
    void RegisterHooks(IClientHooks hooks);

    /// <summary>
    /// Create a payment payload from a set of offered requirements.
    /// Selects a supported requirement and creates a signed payment payload.
    /// </summary>
    /// <param name="requirements">Payment requirements offered by the resource server</param>
    /// <returns>Signed payment payload ready for settlement</returns>
    Task<PaymentPayload> CreatePaymentPayloadAsync(IReadOnlyList<PaymentRequirements> requirements);

    /// <summary>
    /// Create a payment payload from requirements.
    /// Negotiates with registered handlers and applies policies.
    /// </summary>
    /// <param name="requirements">Payment requirements from resource server</param>
    /// <returns>Signed payment payload ready for settlement</returns>
    Task<PaymentPayload> CreatePaymentPayloadAsync(PaymentRequirements requirements);

    /// <summary>
    /// Get the payer address/identifier for this client.
    /// </summary>
    Task<string> GetPayerAsync();
}
