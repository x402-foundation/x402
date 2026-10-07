namespace X402.Core.Roles.Errors;

/// <summary>
/// Base payment error type for all x402 protocol errors.
/// </summary>
public class PaymentError : Exception
{
    /// <summary>
    /// Machine-readable error code (e.g., "INSUFFICIENT_AMOUNT", "INVALID_NETWORK", "EXPIRED").
    /// </summary>
    public string ErrorCode { get; }

    /// <summary>
    /// Additional error details for debugging.
    /// </summary>
    public Dictionary<string, object?> Details { get; }

    public PaymentError(string errorCode, string message, Dictionary<string, object?>? details = null)
        : base(message)
    {
        ErrorCode = errorCode;
        Details = details ?? [];
    }

    public PaymentError(string errorCode, string message, Exception innerException, Dictionary<string, object?>? details = null)
        : base(message, innerException)
    {
        ErrorCode = errorCode;
        Details = details ?? [];
    }
}
