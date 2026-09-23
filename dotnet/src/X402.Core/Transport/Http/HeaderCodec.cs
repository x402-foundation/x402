using System.Text;
using System.Text.Json;
using X402.Core.Protocol.Common;

namespace X402.Core.Transport.Http;

public static class HeaderCodec
{
    public static string Encode<T>(T value)
    {
        var json = JsonSerializer.Serialize(value, X402Json.SerializerOptions);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }

    public static T Decode<T>(string base64HeaderValue)
    {
        if (string.IsNullOrWhiteSpace(base64HeaderValue))
        {
            throw new InvalidDataException("Header value is required.");
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64HeaderValue);
        }
        catch (FormatException ex)
        {
            throw new InvalidDataException("Header is not valid base64.", ex);
        }

        try
        {
            return JsonSerializer.Deserialize<T>(bytes, X402Json.SerializerOptions)
                   ?? throw new InvalidDataException("Decoded header payload was null.");
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("Decoded header is not valid x402 JSON.", ex);
        }
    }
}