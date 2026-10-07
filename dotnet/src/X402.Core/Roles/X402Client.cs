using X402.Core.Protocol.V2;
using X402.Core.Roles.Errors;
using X402.Core.Roles.Hooks;

namespace X402.Core.Roles;

/// <summary>
/// Base implementation of the x402 Client role.
/// Provides handler registry, policy engine, and hook lifecycle.
/// </summary>
public class X402Client : IX402Client
{
    private readonly Dictionary<string, Func<PaymentRequirements, Task<PaymentPayload>>> _schemeHandlers = [];
    private readonly Dictionary<string, Func<PaymentPayload, Task<bool>>> _policies = [];
    private IClientHooks? _hooks;

    public Task<PaymentPayload> CreatePaymentPayloadAsync(IReadOnlyList<PaymentRequirements> requirements)
    {
        if (requirements.Count == 0)
        {
            throw new PaymentError("UNSUPPORTED_SCHEME", "No payment requirements were provided");
        }

        var selectedRequirement = requirements.FirstOrDefault(requirement => _schemeHandlers.ContainsKey(requirement.Scheme));
        if (selectedRequirement is null)
        {
            var offeredSchemes = string.Join(", ", requirements.Select(requirement => requirement.Scheme).Distinct(StringComparer.Ordinal));
            throw new PaymentError(
                "UNSUPPORTED_SCHEME",
                $"No handler registered for offered schemes: {offeredSchemes}");
        }

        return CreatePaymentPayloadAsync(selectedRequirement);
    }

    public void RegisterSchemeHandler(string scheme, Func<PaymentRequirements, Task<PaymentPayload>> handler)
    {
        _schemeHandlers[scheme] = handler;
    }

    public void RegisterPolicy(string policyName, Func<PaymentPayload, Task<bool>> policy)
    {
        _policies[policyName] = policy;
    }

    public void RegisterHooks(IClientHooks hooks)
    {
        _hooks = hooks;
    }

    public async Task<PaymentPayload> CreatePaymentPayloadAsync(PaymentRequirements requirements)
    {
        var context = new ClientHookContext { Requirements = requirements };

        try
        {
            // Execute before hooks
            if (_hooks != null)
            {
                await _hooks.BeforePaymentCreationAsync(context);
                if (context.ShouldAbort)
                {
                    throw new PaymentError("ABORTED_BY_HOOK", "Payment creation aborted by before hook");
                }
            }

            // Lookup handler for scheme
            if (!_schemeHandlers.TryGetValue(requirements.Scheme, out var handler))
            {
                throw new PaymentError("UNSUPPORTED_SCHEME", $"No handler registered for scheme: {requirements.Scheme}");
            }

            // Create payload
            context.Payload = await handler(requirements);

            // Apply policies
            foreach (var (policyName, policy) in _policies)
            {
                var policyPassed = await policy(context.Payload);
                if (!policyPassed)
                {
                    throw new PaymentError("POLICY_VIOLATION", $"Payment failed policy: {policyName}");
                }
            }

            // Execute after hooks
            if (_hooks != null)
            {
                await _hooks.AfterPaymentCreationAsync(context);
            }

            return context.Payload;
        }
        catch (Exception ex)
        {
            context.Error = ex;
            if (_hooks != null)
            {
                await _hooks.OnPaymentCreationFailureAsync(context);
            }

            if (context.ShouldAbort || ex is PaymentError)
            {
                throw;
            }

            throw new PaymentError("CREATION_FAILED", ex.Message, ex);
        }
    }

    public virtual Task<string> GetPayerAsync()
    {
        // Subclasses should override to provide actual payer address
        throw new NotImplementedException("GetPayerAsync must be implemented by derived class");
    }
}
