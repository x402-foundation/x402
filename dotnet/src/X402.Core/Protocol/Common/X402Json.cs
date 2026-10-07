using System.Text.Json;
using System.Text.Json.Serialization;

namespace X402.Core.Protocol.Common;

public static class X402Json
{
    public static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };
}