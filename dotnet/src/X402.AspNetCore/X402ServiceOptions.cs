using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Transport.Http.Adapters;

namespace X402.AspNetCore;

/// <summary>
/// Service-registration options used by <see cref="X402ServiceExtensions.AddX402(Microsoft.Extensions.DependencyInjection.IServiceCollection, Action{X402ServiceOptions})"/>.
/// </summary>
public sealed class X402ServiceOptions
{
    private Func<IServiceProvider, IX402FacilitatorClient>? _facilitatorClientFactory;

    internal IReadOnlyList<string> FacilitatedSchemes => _facilitatedSchemes;
    internal IReadOnlyList<SchemeVerifierRegistration> SchemeVerifierRegistrations => _schemeVerifierRegistrations;
    internal Func<IServiceProvider, IX402FacilitatorClient>? FacilitatorClientFactory => _facilitatorClientFactory;

    private readonly List<string> _facilitatedSchemes = [];
    private readonly List<SchemeVerifierRegistration> _schemeVerifierRegistrations = [];

    /// <summary>
    /// Global facilitator URL used when a route does not provide an override.
    /// </summary>
    public string? DefaultFacilitatorUrl { get; private set; }

    /// <summary>
    /// Register a local verifier callback for a payment scheme.
    /// </summary>
    public X402ServiceOptions RegisterSchemeVerifier(string scheme, Func<PaymentPayload, Task<VerifyResponse>> verifier)
    {
        ArgumentNullException.ThrowIfNull(scheme);
        ArgumentNullException.ThrowIfNull(verifier);

        _schemeVerifierRegistrations.Add(new SchemeVerifierRegistration(scheme, verifier));
        return this;
    }

    /// <summary>
    /// Register a scheme that should be verified through the configured facilitator client.
    /// </summary>
    public X402ServiceOptions RegisterFacilitatedScheme(string scheme)
    {
        ArgumentNullException.ThrowIfNull(scheme);

        _facilitatedSchemes.Add(scheme);
        return this;
    }

    /// <summary>
    /// Use a concrete facilitator client instance for external verification and settlement.
    /// </summary>
    public X402ServiceOptions UseFacilitatorClient(IX402FacilitatorClient facilitatorClient, string? defaultFacilitatorUrl = null)
    {
        ArgumentNullException.ThrowIfNull(facilitatorClient);

        DefaultFacilitatorUrl = defaultFacilitatorUrl;
        _facilitatorClientFactory = _ => facilitatorClient;
        return this;
    }

    /// <summary>
    /// Use the HTTP facilitator client with the provided default URL.
    /// </summary>
    public X402ServiceOptions UseHttpFacilitator(string facilitatorUrl, Action<HttpClient>? configureHttpClient = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(facilitatorUrl);

        DefaultFacilitatorUrl = facilitatorUrl;
        _facilitatorClientFactory = _ =>
        {
            var httpClient = new HttpClient();
            configureHttpClient?.Invoke(httpClient);
            return new HttpFacilitatorClient(httpClient, facilitatorUrl);
        };

        return this;
    }
}

internal sealed record SchemeVerifierRegistration(
    string Scheme,
    Func<PaymentPayload, Task<VerifyResponse>> Verifier);