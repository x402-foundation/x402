namespace X402.AspNetCore;

/// <summary>
/// Runtime x402 options shared across middleware, filters, and DI-constructed services.
/// </summary>
public sealed class X402RuntimeOptions
{
    /// <summary>
    /// Global facilitator URL used when a route does not provide an override.
    /// </summary>
    public string? DefaultFacilitatorUrl { get; init; }
}