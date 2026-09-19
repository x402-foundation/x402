using X402.Core.Protocol.V2;

namespace X402.Core.Roles.Hooks;

/// <summary>
/// Hook context for client lifecycle events. Allows hooks to modify behavior or abort operations.
/// </summary>
public class ClientHookContext
{
    /// <summary>
    /// The payment requirements being processed.
    /// </summary>
    public PaymentRequirements? Requirements { get; set; }

    /// <summary>
    /// The payment payload being created (available after creation).
    /// </summary>
    public PaymentPayload? Payload { get; set; }

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
/// Client-side hook lifecycle for payment creation.
/// </summary>
public interface IClientHooks
{
    /// <summary>
    /// Called before payment payload creation. Can abort operation or modify requirements.
    /// </summary>
    Task BeforePaymentCreationAsync(ClientHookContext context);

    /// <summary>
    /// Called after successful payment payload creation.
    /// </summary>
    Task AfterPaymentCreationAsync(ClientHookContext context);

    /// <summary>
    /// Called when payment creation fails. Can attempt recovery by setting ShouldAbort = false.
    /// </summary>
    Task OnPaymentCreationFailureAsync(ClientHookContext context);
}
