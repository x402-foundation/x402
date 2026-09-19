namespace X402.Core.Roles.Errors;

/// <summary>
/// Error returned when payment verification fails.
/// </summary>
public class VerifyError : PaymentError
{
    /// <summary>
    /// Reason why verification failed (e.g., "INVALID_SIGNATURE", "INSUFFICIENT_AMOUNT", "EXPIRED_PAYMENT").
    /// </summary>
    public string InvalidReason { get; }

    /// <summary>
    /// The payer address/identifier involved in the failed verification.
    /// </summary>
    public string? Payer { get; }

    /// <summary>
    /// Human-readable message explaining the verification failure.
    /// </summary>
    public string? InvalidMessage { get; }

    public VerifyError(
        string invalidReason,
        string message,
        string? payer = null,
        string? invalidMessage = null,
        Dictionary<string, object?>? details = null)
        : base("VERIFY_FAILED", message, details)
    {
        InvalidReason = invalidReason;
        Payer = payer;
        InvalidMessage = invalidMessage;
    }
}
