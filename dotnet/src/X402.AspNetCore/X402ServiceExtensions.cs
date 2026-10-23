using Microsoft.Extensions.DependencyInjection;
using X402.Core.Roles;

namespace X402.AspNetCore;

/// <summary>
/// Extension methods for registering x402 services with the DI container.
/// </summary>
public static class X402ServiceExtensions
{
    /// <summary>
    /// Registers <see cref="IX402ResourceServer"/>, <see cref="IX402Client"/>, and
    /// <see cref="IX402Facilitator"/> as singleton services.
    /// Call this once from <c>Program.cs</c> before <c>app.UseX402Payment()</c>.
    /// </summary>
    public static IServiceCollection AddX402(this IServiceCollection services)
    {
        return services.AddX402(static _ => { });
    }

    /// <summary>
    /// Registers x402 services and configures optional facilitator-backed verification.
    /// </summary>
    public static IServiceCollection AddX402(this IServiceCollection services, Action<X402ServiceOptions> configure)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configure);

        var options = new X402ServiceOptions();
        configure(options);

        if (options.FacilitatedSchemes.Count > 0 && options.FacilitatorClientFactory is null)
        {
            throw new InvalidOperationException(
                "Facilitated schemes require a facilitator client. Call UseHttpFacilitator(...) or UseFacilitatorClient(...)."
            );
        }

        services.AddSingleton<IX402Client, X402Client>();
        services.AddSingleton<IX402Facilitator, X402Facilitator>();
        services.AddSingleton(new X402RuntimeOptions { DefaultFacilitatorUrl = options.DefaultFacilitatorUrl });

        if (options.FacilitatorClientFactory is not null)
            services.AddSingleton<IX402FacilitatorClient>(sp => options.FacilitatorClientFactory(sp));

        services.AddSingleton<IX402ResourceServer>(sp =>
        {
            var facilitatorClient = sp.GetService<IX402FacilitatorClient>();
            var server = new X402ResourceServer(facilitatorClient, options.DefaultFacilitatorUrl);

            foreach (var registration in options.SchemeVerifierRegistrations)
                server.RegisterSchemeVerifier(registration.Scheme, registration.Verifier);

            foreach (var scheme in options.FacilitatedSchemes)
                server.RegisterFacilitatedScheme(scheme);

            return server;
        });

        services.AddSingleton<X402PaymentEnforcer>();

        return services;
    }
}
