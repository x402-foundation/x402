using X402.Core.Protocol.V2;
using X402.Core.Roles.Errors;
using X402.Core.Roles.Hooks;

namespace X402.Core.Roles;

/// <summary>
/// Base implementation of the x402 ResourceServer role.
/// Provides handler registry, resource requirement management, and hook lifecycle.
/// </summary>
public class X402ResourceServer : IX402ResourceServer
{
    private readonly IX402FacilitatorClient? _facilitatorClient;
    private readonly string? _defaultFacilitatorUrl;
    private readonly Dictionary<string, Func<PaymentPayload, Task<VerifyResponse>>> _verifiers = [];
    private readonly HashSet<string> _facilitatedSchemes = [];
    private readonly Dictionary<string, PaymentRequirements> _requirements = [];
    private IServerHooks? _hooks;

    public X402ResourceServer()
    {
    }

    public X402ResourceServer(IX402FacilitatorClient? facilitatorClient, string? defaultFacilitatorUrl = null)
    {
        _facilitatorClient = facilitatorClient;
        _defaultFacilitatorUrl = defaultFacilitatorUrl;
    }

    public void RegisterSchemeVerifier(string scheme, Func<PaymentPayload, Task<VerifyResponse>> verifier)
    {
        _verifiers[scheme] = verifier;
    }

    public void RegisterFacilitatedScheme(string scheme)
    {
        _facilitatedSchemes.Add(scheme);
    }

    public void Initialize(string resourcePath, PaymentRequirements requirements)
    {
        _requirements[resourcePath] = requirements;
    }

    public void RegisterHooks(IServerHooks hooks)
    {
        _hooks = hooks;
    }

    public async Task<VerifyResponse> VerifyPaymentAsync(PaymentPayload payload, string? facilitatorUrl = null)
    {
        var context = new ServerHookContext { Payload = payload };

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
                if (_facilitatedSchemes.Contains(payload.Accepted.Scheme) && _facilitatorClient is not null)
                {
                    context.VerifyResponse = await _facilitatorClient.VerifyAsync(payload, facilitatorUrl ?? _defaultFacilitatorUrl);
                }
                else
                {
                    throw new VerifyError("UNSUPPORTED_SCHEME", $"No verifier registered for scheme: {payload.Accepted.Scheme}");
                }
            }
            else
            {
                // Verify payload
                context.VerifyResponse = await verifier(payload);
            }

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

    public virtual Task<SettleResponse> SettlePaymentAsync(PaymentPayload payload, string? facilitatorUrl = null)
    {
        if (_facilitatedSchemes.Contains(payload.Accepted.Scheme) && _facilitatorClient is not null)
            return _facilitatorClient.SettleAsync(payload, facilitatorUrl ?? _defaultFacilitatorUrl);

        // Subclasses should override to provide actual settlement logic
        throw new NotImplementedException("SettlePaymentAsync must be implemented by derived class");
    }

    public Task<PaymentRequirements?> GetRequirementsAsync(string resourcePath)
    {
        _requirements.TryGetValue(resourcePath, out var requirements);
        return Task.FromResult(requirements);
    }
}
