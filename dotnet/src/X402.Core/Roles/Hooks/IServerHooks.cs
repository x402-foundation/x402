using X402.Core.Protocol.V2;

namespace X402.Core.Roles.Hooks;

/// <summary>
/// Hook context for server/resource server lifecycle events.
/// </summary>
public class ServerHookContext
{
    /// <summary>
    /// The payment payload received.
    /// </summary>
    public PaymentPayload Payload { get; set; } = null!;

    /// <summary>
    /// The verification response (available after verification).
    /// </summary>
    public Protocol.V2.VerifyResponse? VerifyResponse { get; set; }

    /// <summary>
    /// Any error that occurred.
    /// </summary>
    public Exception? Error { get; set; }

    /// <summary>
    /// Whether the operation should be aborted.
    /// </summary>
    public bool ShouldAbort { get; set; }

    /// <summary>
    /// Custom metadata for hook chain communication.
    /// </summary>
    public Dictionary<string, object?> Metadata { get; set; } = [];
}

/// <summary>
/// Server-side hook lifecycle for payment verification and resource access.
/// </summary>
public interface IServerHooks
{
    /// <summary>
    /// Called before payment verification. Can abort or preprocess.
    /// </summary>
    Task BeforeVerifyAsync(ServerHookContext context);

    /// <summary>
    /// Called after successful verification. Can post-process or enforce policies.
    /// </summary>
    Task AfterVerifyAsync(ServerHookContext context);

    /// <summary>
    /// Called when verification fails.
    /// </summary>
    Task OnVerifyFailureAsync(ServerHookContext context);
}
