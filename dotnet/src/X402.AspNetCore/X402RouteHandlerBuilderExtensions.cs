using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using X402.Core.Protocol.V2;

namespace X402.AspNetCore;

public static class X402RouteHandlerBuilderExtensions
{
    /// <summary>
    /// Protects a minimal API endpoint with the provided payment requirements.
    /// </summary>
    public static RouteHandlerBuilder RequireX402Payment(
        this RouteHandlerBuilder builder,
        PaymentRequirements requirements)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(requirements);

        builder.AddEndpointFilter(async (context, next) =>
        {
            if (context.HttpContext.Items.TryGetValue(X402HttpContextKeys.Verified, out var verifiedObj)
            && verifiedObj is bool and true)
                return await next(context);

            var enforcer = context.HttpContext.RequestServices.GetRequiredService<X402PaymentEnforcer>();
            var path = context.HttpContext.Request.Path.Value ?? string.Empty;
            var allowed = await enforcer.EnforceAsync(context.HttpContext, requirements, path);
            if (!allowed)
                return Results.Empty;

            return await next(context);
        });

        return builder;
    }

    /// <summary>
    /// Protects a minimal API endpoint using scalar requirement values.
    /// </summary>
    public static RouteHandlerBuilder RequireX402Payment(
        this RouteHandlerBuilder builder,
        string scheme,
        string network,
        string asset,
        string amount,
        string payTo,
        int maxTimeoutSeconds = 300,
        string? tokenName = null,
        string? tokenVersion = null)
    {
        ArgumentNullException.ThrowIfNull(scheme);
        ArgumentNullException.ThrowIfNull(network);
        ArgumentNullException.ThrowIfNull(asset);
        ArgumentNullException.ThrowIfNull(amount);
        ArgumentNullException.ThrowIfNull(payTo);

        JsonObject? extra = null;
        if (!string.IsNullOrWhiteSpace(tokenName) || !string.IsNullOrWhiteSpace(tokenVersion))
        {
            extra = new JsonObject();
            if (!string.IsNullOrWhiteSpace(tokenName))
                extra["name"] = tokenName;
            if (!string.IsNullOrWhiteSpace(tokenVersion))
                extra["version"] = tokenVersion;
        }

        var requirements = new PaymentRequirements(
            scheme,
            network,
            asset,
            amount,
            payTo,
            maxTimeoutSeconds,
            extra);

        return builder.RequireX402Payment(requirements);
    }
}
