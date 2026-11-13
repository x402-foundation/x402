using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace X402.Mechanisms.Evm.Exact;

/// <summary>
/// EIP-3009 <c>TransferWithAuthorization</c> authorization fields.
/// All numeric fields are stored as decimal strings to preserve precision.
/// </summary>
public sealed class Eip3009Authorization
{
    [JsonPropertyName("from")]
    public string From { get; init; } = string.Empty;

    [JsonPropertyName("to")]
    public string To { get; init; } = string.Empty;

    /// <summary>Amount in the token's smallest unit (e.g. wei for 18-decimal tokens).</summary>
    [JsonPropertyName("value")]
    public string Value { get; init; } = string.Empty;

    /// <summary>Unix timestamp — authorization is invalid before this time.</summary>
    [JsonPropertyName("validAfter")]
    public string ValidAfter { get; init; } = string.Empty;

    /// <summary>Unix timestamp — authorization expires after this time.</summary>
    [JsonPropertyName("validBefore")]
    public string ValidBefore { get; init; } = string.Empty;

    /// <summary>32-byte random nonce, hex-encoded (0x-prefixed).</summary>
    [JsonPropertyName("nonce")]
    public string Nonce { get; init; } = string.Empty;
}

/// <summary>
/// EIP-3009 payment payload — the scheme-specific data inside
/// <see cref="X402.Core.Protocol.V2.PaymentPayload.Payload"/>.
/// </summary>
public sealed class Eip3009Payload
{
    [JsonPropertyName("authorization")]
    public Eip3009Authorization Authorization { get; init; } = new();

    /// <summary>Hex-encoded ECDSA signature (0x-prefixed, 65 bytes = 130 hex chars).</summary>
    [JsonPropertyName("signature")]
    public string? Signature { get; init; }

    /// <summary>
    /// Attempt to deserialize from a <see cref="JsonObject"/> stored in
    /// <c>PaymentPayload.Payload</c>.
    /// </summary>
    public static Eip3009Payload? FromJsonObject(JsonObject? obj)
    {
        if (obj is null) return null;
        var json = obj.ToJsonString();
        return JsonSerializer.Deserialize<Eip3009Payload>(json,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
    }
}
