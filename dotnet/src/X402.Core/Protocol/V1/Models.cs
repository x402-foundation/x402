using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace X402.Core.Protocol.V1;

public sealed record PaymentRequirements(
    [property: JsonPropertyName("scheme")] string Scheme,
    [property: JsonPropertyName("network")] string Network,
    [property: JsonPropertyName("maxAmountRequired")] string MaxAmountRequired,
    [property: JsonPropertyName("asset")] string Asset,
    [property: JsonPropertyName("payTo")] string PayTo,
    [property: JsonPropertyName("resource")] string Resource,
    [property: JsonPropertyName("description")] string? Description = null,
    [property: JsonPropertyName("mimeType")] string? MimeType = null,
    [property: JsonPropertyName("outputSchema")] JsonObject? OutputSchema = null,
    [property: JsonPropertyName("maxTimeoutSeconds")] int MaxTimeoutSeconds = 60,
    [property: JsonPropertyName("extra")] JsonObject? Extra = null
);

public sealed record PaymentRequired(
    [property: JsonPropertyName("x402Version")] int X402Version,
    [property: JsonPropertyName("accepts")] IReadOnlyList<PaymentRequirements> Accepts,
    [property: JsonPropertyName("error")] string? Error = null
);

public sealed record PaymentPayload(
    [property: JsonPropertyName("x402Version")] int X402Version,
    [property: JsonPropertyName("scheme")] string Scheme,
    [property: JsonPropertyName("network")] string Network,
    [property: JsonPropertyName("payload")] JsonObject Payload
);