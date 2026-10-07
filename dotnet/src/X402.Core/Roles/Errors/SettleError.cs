namespace X402.Core.Roles.Errors;

/// <summary>
/// Error returned when payment settlement fails.
/// </summary>
public class SettleError : PaymentError
{
    /// <summary>
    /// Reason for settlement failure (e.g., "INSUFFICIENT_BALANCE", "TRANSACTION_FAILED", "NETWORK_ERROR").
    /// </summary>
    public string ErrorReason { get; }

    /// <summary>
    /// The payer address/identifier involved in the failed settlement.
    /// </summary>
    public string? Payer { get; }

    /// <summary>
    /// Network identifier (CAIP-2 format, e.g., "eip155:84532").
    /// </summary>
    public string? Network { get; }

    /// <summary>
    /// Transaction hash or identifier (if applicable).
    /// </summary>
    public string? Transaction { get; }

    public SettleError(
        string errorReason,
        string message,
        string? payer = null,
        string? network = null,
        string? transaction = null,
        Dictionary<string, object?>? details = null)
        : base("SETTLE_FAILED", message, details)
    {
        ErrorReason = errorReason;
        Payer = payer;
        Network = network;
        Transaction = transaction;
    }
}
