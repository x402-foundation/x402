using Microsoft.AspNetCore.Http;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Core.Transport.Http;

namespace X402.AspNetCore;

/// <summary>
/// Shared payment enforcement flow for middleware, endpoint filters, and MVC filters.
/// </summary>
public sealed class X402PaymentEnforcer
{
    private readonly IX402ResourceServer _server;
    private readonly X402RuntimeOptions _runtimeOptions;

    public X402PaymentEnforcer(IX402ResourceServer server)
        : this(server, new X402RuntimeOptions())
    {
    }

    public X402PaymentEnforcer(IX402ResourceServer server, X402RuntimeOptions runtimeOptions)
    {
        _server = server;
        _runtimeOptions = runtimeOptions;
    }

    /// <summary>
    /// Enforces x402 payment requirements for the current request.
    /// Returns <c>true</c> when the request may continue to the handler.
    /// </summary>
    public async Task<bool> EnforceAsync(
        HttpContext context,
        PaymentRequirements requirements,
        string? resourcePath = null,
        string? facilitatorUrl = null)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(requirements);

        var path = resourcePath ?? context.Request.Path.Value ?? string.Empty;

        _server.Initialize(path, requirements);

        if (!context.Request.Headers.TryGetValue(X402HttpHeaders.PaymentSignature, out var headerValues)
            || string.IsNullOrEmpty(headerValues))
        {
            var paymentRequired = new PaymentRequired(2, [requirements]);
            var encoded = HeaderCodec.Encode(paymentRequired);
            context.Response.Headers.Append(X402HttpHeaders.PaymentRequired, encoded);
            context.Response.StatusCode = StatusCodes.Status402PaymentRequired;
            return false;
        }

        PaymentPayload? payload;
        try
        {
            payload = HeaderCodec.Decode<PaymentPayload>(headerValues.ToString());
        }
        catch
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return false;
        }

        if (payload is null)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return false;
        }

        VerifyResponse verifyResult;
        try
        {
            verifyResult = await _server.VerifyPaymentAsync(payload, facilitatorUrl ?? _runtimeOptions.DefaultFacilitatorUrl);
        }
        catch
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return false;
        }

        if (!verifyResult.IsValid)
        {
            context.Response.Headers.Append("x402-invalid-reason", verifyResult.InvalidReason ?? "payment_invalid");
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return false;
        }

        if (verifyResult.Payer is not null)
            context.Items[X402HttpContextKeys.Payer] = verifyResult.Payer;
        context.Items[X402HttpContextKeys.Payload] = payload;
        context.Items[X402HttpContextKeys.Verified] = true;
        return true;
    }
}
