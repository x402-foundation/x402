using X402.Core.Protocol.V2;

namespace X402.Core.Roles.Hooks;

/// <summary>
/// Hook context for facilitator lifecycle events (verify and settle operations).
/// </summary>
public class FacilitatorHookContext
{
    /// <summary>
    /// The payment payload being processed.
    /// </summary>
    public PaymentPayload Payload { get; set; } = null!;

    /// <summary>
    /// The operation type: "verify" or "settle".
    /// </summary>
    public string OperationType { get; set; } = "";

    /// <summary>
    /// Verify response (if OperationType is "verify").
    /// </summary>
    public Protocol.V2.VerifyResponse? VerifyResponse { get; set; }

    /// <summary>
    /// Settle response (if OperationType is "settle").
    /// </summary>
    public Protocol.V2.SettleResponse? SettleResponse { get; set; }

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
/// Facilitator-side hook lifecycle for payment verification and settlement.
/// </summary>
public interface IFacilitatorHooks
{
    /// <summary>
    /// Called before payment verification. Can abort or add validation rules.
    /// </summary>
    Task BeforeVerifyAsync(FacilitatorHookContext context);

    /// <summary>
    /// Called after successful verification.
    /// </summary>
    Task AfterVerifyAsync(FacilitatorHookContext context);

    /// <summary>
    /// Called when verification fails.
    /// </summary>
    Task OnVerifyFailureAsync(FacilitatorHookContext context);

    /// <summary>
    /// Called before payment settlement. Can abort or apply final validation.
    /// </summary>
    Task BeforeSettleAsync(FacilitatorHookContext context);

    /// <summary>
    /// Called after successful settlement.
    /// </summary>
    Task AfterSettleAsync(FacilitatorHookContext context);

    /// <summary>
    /// Called when settlement fails.
    /// </summary>
    Task OnSettleFailureAsync(FacilitatorHookContext context);
}
