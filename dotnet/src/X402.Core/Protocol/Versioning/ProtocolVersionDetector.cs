using System.Text.Json;
using X402.Core.Protocol.Common;

namespace X402.Core.Protocol.Versioning;

public static class ProtocolVersionDetector
{
    public const int V1 = 1;
    public const int V2 = 2;

    public static int DetectVersion(ReadOnlySpan<byte> utf8Json)
    {
        using var doc = JsonDocument.Parse(utf8Json.ToArray());
        if (!doc.RootElement.TryGetProperty("x402Version", out var versionElement))
        {
            throw new InvalidDataException("x402Version is required.");
        }

        if (versionElement.ValueKind != JsonValueKind.Number || !versionElement.TryGetInt32(out var version))
        {
            throw new InvalidDataException("x402Version must be an integer.");
        }

        return version;
    }

    public static int DetectVersion(string json)
    {
        return DetectVersion(System.Text.Encoding.UTF8.GetBytes(json));
    }

    public static object DeserializePaymentPayload(string json)
    {
        var version = DetectVersion(json);
        return version switch
        {
            V1 => JsonSerializer.Deserialize<Protocol.V1.PaymentPayload>(json, X402Json.SerializerOptions)
                  ?? throw new InvalidDataException("Failed to deserialize v1 payment payload."),
            V2 => JsonSerializer.Deserialize<Protocol.V2.PaymentPayload>(json, X402Json.SerializerOptions)
                  ?? throw new InvalidDataException("Failed to deserialize v2 payment payload."),
            _ => throw new NotSupportedException($"Unsupported x402Version: {version}")
        };
    }
}