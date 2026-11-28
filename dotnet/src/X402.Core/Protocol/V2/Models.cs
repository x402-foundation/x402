using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using X402.Core.Protocol.Common;

namespace X402.Core.Protocol.V2;

public sealed record ResourceInfo(
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("description")] string? Description = null,
    [property: JsonPropertyName("mimeType")] string? MimeType = null
);

public sealed record PaymentRequirements(
    [property: JsonPropertyName("scheme")] string Scheme,
    [property: JsonPropertyName("network")] string Network,
    [property: JsonPropertyName("asset")] string Asset,
    [property: JsonPropertyName("amount")] string Amount,
    [property: JsonPropertyName("payTo")] string PayTo,
    [property: JsonPropertyName("maxTimeoutSeconds")] int MaxTimeoutSeconds,
    [property: JsonPropertyName("extra")] JsonObject? Extra = null
);

public sealed record PaymentRequired(
    [property: JsonPropertyName("x402Version")] int X402Version,
    [property: JsonPropertyName("accepts")] IReadOnlyList<PaymentRequirements> Accepts,
    [property: JsonPropertyName("error")] string? Error = null,
    [property: JsonPropertyName("resource")] ResourceInfo? Resource = null,
    [property: JsonPropertyName("extensions")] Dictionary<string, ProtocolExtension>? Extensions = null
);

public sealed record PaymentPayload(
    [property: JsonPropertyName("x402Version")] int X402Version,
    [property: JsonPropertyName("accepted")] PaymentRequirements Accepted,
    [property: JsonPropertyName("payload")] JsonObject Payload,
    [property: JsonPropertyName("resource")] ResourceInfo? Resource = null,
    [property: JsonPropertyName("extensions")] Dictionary<string, ProtocolExtension>? Extensions = null
);

public sealed record VerifyResponse(
    [property: JsonPropertyName("isValid")] bool IsValid,
    [property: JsonPropertyName("invalidReason")] string? InvalidReason = null,
    [property: JsonPropertyName("payer")] string? Payer = null
);

public sealed record SettleResponse(
    [property: JsonPropertyName("success")] bool Success,
    [property: JsonPropertyName("transaction")] string Transaction,
    [property: JsonPropertyName("network")] string Network,
    [property: JsonPropertyName("errorReason")] string? ErrorReason = null,
    [property: JsonPropertyName("payer")] string? Payer = null,
    [property: JsonPropertyName("amount")] string? Amount = null,
    [property: JsonPropertyName("extensions")] Dictionary<string, ProtocolExtension>? Extensions = null
);

public sealed record VerifyRequest(
    [property: JsonPropertyName("x402Version")] int X402Version,
    [property: JsonPropertyName("paymentPayload")] PaymentPayload PaymentPayload
);

public sealed record SettleRequest(
    [property: JsonPropertyName("x402Version")] int X402Version,
    [property: JsonPropertyName("paymentPayload")] PaymentPayload PaymentPayload
);