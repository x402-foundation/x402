using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace X402.Core.Protocol.Common;

public sealed record ProtocolExtension(
    [property: JsonPropertyName("info")] JsonObject Info,
    [property: JsonPropertyName("schema")] JsonObject Schema
);