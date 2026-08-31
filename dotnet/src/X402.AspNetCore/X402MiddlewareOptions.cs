using X402.Core.Protocol.V2;

namespace X402.AspNetCore;

/// <summary>
/// Describes a single route that requires x402 payment before access.
/// </summary>
public sealed record ProtectedRoute(
    /// <summary>Path prefix that triggers payment enforcement (e.g. "/api/premium").</summary>
    string Path,
    /// <summary>Payment requirements advertised in the 402 response for this route.</summary>
    PaymentRequirements Requirements,
    /// <summary>Optional per-route facilitator override URL.</summary>
    string? FacilitatorUrl = null
);

/// <summary>
/// Configuration options for <see cref="X402PaymentMiddleware"/>.
/// </summary>
public sealed class X402MiddlewareOptions
{
    /// <summary>All routes that require payment.</summary>
    public List<ProtectedRoute> ProtectedRoutes { get; } = [];

    /// <summary>Default facilitator URL used when a route does not specify one.</summary>
    public string? DefaultFacilitatorUrl { get; set; }

    /// <summary>
    /// Fluent helper: protect <paramref name="path"/> with the given <paramref name="requirements"/>.
    /// The path is matched as a prefix — /api/premium also matches /api/premium/video.
    /// </summary>
    public X402MiddlewareOptions Protect(string path, PaymentRequirements requirements, string? facilitatorUrl = null)
    {
        ProtectedRoutes.Add(new ProtectedRoute(path, requirements, facilitatorUrl));
        return this;
    }

    /// <summary>
    /// Returns the first route whose path is a prefix of <paramref name="requestPath"/>,
    /// or <c>null</c> if the request is unprotected.
    /// </summary>
    public ProtectedRoute? Match(string requestPath)
    {
        return ProtectedRoutes.FirstOrDefault(r =>
            requestPath == r.Path || requestPath.StartsWith(r.Path + "/", StringComparison.OrdinalIgnoreCase));
    }
}
