using X402.Core.Protocol.V2;
using X402.Core.Roles.Errors;
using X402.Core.Roles.Hooks;

namespace X402.Core.Roles;

/// <summary>
/// Base implementation of the x402 Facilitator role.
/// Provides handler registry, extension support, and hook lifecycle.
/// </summary>
public class X402Facilitator : IX402Facilitator
{
    private readonly Dictionary<string, Func<PaymentPayload, Task<VerifyResponse>>> _verifiers = [];
    private readonly Dictionary<string, Func<PaymentPayload, Task<SettleResponse>>> _settlers = [];
    private readonly Dictionary<string, Func<Dictionary<string, object?>, Task>> _extensions = [];
    private IFacilitatorHooks? _hooks;

    public void RegisterSchemeVerifier(string scheme, Func<PaymentPayload, Task<VerifyResponse>> verifier)
    {
        _verifiers[scheme] = verifier;
    }

    public void RegisterSchemeSettler(string scheme, Func<PaymentPayload, Task<SettleResponse>> settler)
    {
        _settlers[scheme] = settler;
    }

    public void RegisterExtension(string extensionName, Func<Dictionary<string, object?>, Task> handler)
    {
        _extensions[extensionName] = handler;
    }

    public void RegisterHooks(IFacilitatorHooks hooks)
    {
        _hooks = hooks;
    }

    public async Task<VerifyResponse> VerifyAsync(PaymentPayload payload)
    {
        var context = new FacilitatorHookContext { Payload = payload, OperationType = "verify" };

        try
        {
            // Execute before hooks
            if (_hooks != null)
            {
                await _hooks.BeforeVerifyAsync(context);
                if (context.ShouldAbort)
                {
                    throw new VerifyError("ABORTED_BY_HOOK", "Verification aborted by before hook");
                }
            }

            // Lookup verifier for scheme
            if (!_verifiers.TryGetValue(payload.Accepted.Scheme, out var verifier))
            {
                throw new VerifyError("UNSUPPORTED_SCHEME", $"No verifier registered for scheme: {payload.Accepted.Scheme}");
            }

            // Verify payload
            context.VerifyResponse = await verifier(payload);

            // Extensions processing deferred to Phase 3+
            // TODO: Handle extension processing when extension handlers are formalized

            // Execute after hooks
            if (_hooks != null)
            {
                await _hooks.AfterVerifyAsync(context);
            }

            return context.VerifyResponse;
        }
        catch (Exception ex)
        {
            context.Error = ex;
            if (_hooks != null)
            {
                await _hooks.OnVerifyFailureAsync(context);
            }

            if (ex is VerifyError)
            {
                throw;
            }

            throw new VerifyError("VERIFY_FAILED", ex.Message, null, ex.Message);
        }
    }

    public async Task<SettleResponse> SettleAsync(PaymentPayload payload)
    {
        var context = new FacilitatorHookContext { Payload = payload, OperationType = "settle" };

        try
        {
            // Execute before hooks
            if (_hooks != null)
            {
                await _hooks.BeforeSettleAsync(context);
                if (context.ShouldAbort)
                {
                    throw new SettleError("ABORTED_BY_HOOK", "Settlement aborted by before hook");
                }
            }

            // Lookup settler for scheme
            if (!_settlers.TryGetValue(payload.Accepted.Scheme, out var settler))
            {
                throw new SettleError("UNSUPPORTED_SCHEME", $"No settler registered for scheme: {payload.Accepted.Scheme}");
            }

            // Settle payload
            context.SettleResponse = await settler(payload);

            // Extensions processing deferred to Phase 3+
            // TODO: Handle extension processing when extension handlers are formalized

            // Execute after hooks
            if (_hooks != null)
            {
                await _hooks.AfterSettleAsync(context);
            }

            return context.SettleResponse;
        }
        catch (Exception ex)
        {
            context.Error = ex;
            if (_hooks != null)
            {
                await _hooks.OnSettleFailureAsync(context);
            }

            if (ex is SettleError)
            {
                throw;
            }

            throw new SettleError("SETTLE_FAILED", ex.Message);
        }
    }
}
