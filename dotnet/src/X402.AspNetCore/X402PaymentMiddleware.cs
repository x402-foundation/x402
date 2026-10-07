using Microsoft.AspNetCore.Http;
using X402.Core.Protocol.V2;
using X402.Core.Roles;

namespace X402.AspNetCore;

/// <summary>
/// ASP.NET Core middleware that enforces x402 payment before serving protected resources.
///
/// Flow:
///   1. If the request path is not protected → pass through.
///   2. If the request lacks a PAYMENT-SIGNATURE header → respond 402 with PaymentRequired.
///   3. Decode and verify the payment payload via the registered <see cref="IX402ResourceServer"/>.
///   4. If verification fails → respond 403.
///   5. If verification succeeds → attach payer metadata and call the next delegate.
/// </summary>
public sealed class X402PaymentMiddleware
{
    private readonly RequestDelegate _next;
    private readonly X402MiddlewareOptions _options;
    private readonly X402PaymentEnforcer _enforcer;

    public X402PaymentMiddleware(
        RequestDelegate next,
        X402MiddlewareOptions options,
        IX402ResourceServer server,
        X402PaymentEnforcer enforcer)
    {
        _next = next;
        _options = options;
        _enforcer = enforcer;

        // Pre-initialise the server with every protected route's requirements.
        foreach (var route in options.ProtectedRoutes)
        {
            server.Initialize(route.Path, route.Requirements);
        }
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // Annotation/filter-based protection already verified this request.
        if (context.Items.TryGetValue(X402HttpContextKeys.Verified, out var verifiedObj)
            && verifiedObj is bool verified
            && verified)
        {
            await _next(context);
            return;
        }

        var requestPath = context.Request.Path.Value ?? string.Empty;
        var route = _options.Match(requestPath);

        // Route not protected — let it through.
        if (route is null)
        {
            await _next(context);
            return;
        }

        var allowed = await _enforcer.EnforceAsync(
          context,
          route.Requirements,
          route.Path,
          route.FacilitatorUrl ?? _options.DefaultFacilitatorUrl);
        if (!allowed)
            return;

        await _next(context);
    }
}
