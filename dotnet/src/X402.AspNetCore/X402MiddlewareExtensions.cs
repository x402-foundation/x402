using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace X402.AspNetCore;

/// <summary>
/// Extension methods for adding x402 payment enforcement to the ASP.NET Core middleware pipeline.
/// </summary>
public static class X402MiddlewareExtensions
{
    /// <summary>
    /// Adds the x402 payment middleware using pre-built <paramref name="options"/>.
    /// </summary>
    public static IApplicationBuilder UseX402Payment(this IApplicationBuilder app, X402MiddlewareOptions options)
    {
        ArgumentNullException.ThrowIfNull(app);
        ArgumentNullException.ThrowIfNull(options);

        return app.UseMiddleware<X402PaymentMiddleware>(options);
    }

    /// <summary>
    /// Adds the x402 payment middleware and configures it with <paramref name="configure"/>.
    /// </summary>
    public static IApplicationBuilder UseX402Payment(
        this IApplicationBuilder app,
        Action<X402MiddlewareOptions> configure)
    {
        ArgumentNullException.ThrowIfNull(app);
        ArgumentNullException.ThrowIfNull(configure);

        var options = new X402MiddlewareOptions();
        configure(options);
        return app.UseX402Payment(options);
    }
}
