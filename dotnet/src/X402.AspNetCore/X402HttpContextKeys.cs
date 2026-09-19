namespace X402.AspNetCore;

/// <summary>
/// Keys used in <see cref="Microsoft.AspNetCore.Http.HttpContext.Items"/> during x402 processing.
/// </summary>
public static class X402HttpContextKeys
{
    public const string Payer = "x402-payer";
    public const string Payload = "x402-payload";
    public const string Verified = "x402-verified";
}
