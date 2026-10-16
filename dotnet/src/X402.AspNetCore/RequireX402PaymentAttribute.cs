using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using X402.Core.Protocol.V2;

namespace X402.AspNetCore;

/// <summary>
/// MVC annotation that protects a controller or action with x402 payment checks.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class RequireX402PaymentAttribute : TypeFilterAttribute
{
    public RequireX402PaymentAttribute(
        string scheme,
        string network,
        string asset,
        string amount,
        string payTo,
        int maxTimeoutSeconds = 300,
        string? tokenName = null,
        string? tokenVersion = null)
        : base(typeof(RequireX402PaymentFilter))
    {
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

        Arguments = [requirements];
        Order = int.MinValue;
    }
}

/// <summary>
/// MVC resource filter used by <see cref="RequireX402PaymentAttribute"/>.
/// </summary>
public sealed class RequireX402PaymentFilter : IAsyncResourceFilter
{
    private readonly X402PaymentEnforcer _enforcer;
    private readonly PaymentRequirements _requirements;

    public RequireX402PaymentFilter(X402PaymentEnforcer enforcer, PaymentRequirements requirements)
    {
        _enforcer = enforcer;
        _requirements = requirements;
    }

    public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
    {
        if (context.HttpContext.Items.TryGetValue(X402HttpContextKeys.Verified, out var verifiedObj)
            && verifiedObj is bool verified
            && verified)
        {
            await next();
            return;
        }

        var path = context.HttpContext.Request.Path.Value ?? string.Empty;
        var allowed = await _enforcer.EnforceAsync(context.HttpContext, _requirements, path);
        if (!allowed)
        {
            context.Result = new EmptyResult();
            return;
        }

        await next();
    }
}
