using X402.Core.Protocol.V2;

namespace X402.Core.Transport.Http.Responses;

/// <summary>
/// HTTP wrapper for facilitator settle response.
/// </summary>
public class FacilitatorSettleResponse
{
    /// <summary>
    /// Settlement result from facilitator.
    /// </summary>
    public required SettleResponse Result { get; init; }

    /// <summary>
    /// HTTP status code from facilitator response (typically 200).
    /// </summary>
    public int StatusCode { get; init; } = 200;

    /// <summary>
    /// Custom headers from facilitator response.
    /// </summary>
    public Dictionary<string, string> Headers { get; init; } = [];
}
