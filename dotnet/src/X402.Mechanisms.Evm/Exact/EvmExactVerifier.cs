using System.Numerics;
using X402.Core.Protocol.V2;

namespace X402.Mechanisms.Evm.Exact;

/// <summary>
/// Verifier for the <c>evm-exact</c> payment scheme.
///
/// <para>
/// Validates an EIP-3009 <c>TransferWithAuthorization</c> payload without any
/// on-chain RPC calls — pure off-chain signature verification.  This is the
/// correct approach for the resource-server role.  A facilitator that also
/// wants to perform on-chain simulation would wrap this verifier with an
/// additional RPC check.
/// </para>
///
/// <para>
/// Checks performed (in order):
/// <list type="number">
///   <item>Scheme matches "evm-exact".</item>
///   <item>Network matches requirements.</item>
///   <item>Payload deserialises as <see cref="Eip3009Payload"/>.</item>
///   <item>Signature is present.</item>
///   <item>EIP-712 domain fields (name, version) are present in requirements.Extra.</item>
///   <item>Recipient address matches requirements.PayTo.</item>
///   <item>Authorised amount matches requirements.Amount.</item>
///   <item>Timestamp window is valid (validAfter ≤ now &lt; validBefore − 6 s).</item>
///   <item>EIP-712 + ECDSA: signature recovers to the <c>from</c> address.</item>
/// </list>
/// </para>
/// </summary>
public static class EvmExactVerifier
{
    /// <summary>
    /// Returns a <c>Func</c> suitable for passing to
    /// <see cref="X402.Core.Roles.IX402ResourceServer.RegisterSchemeVerifier"/> or
    /// <see cref="X402.Core.Roles.IX402Facilitator.RegisterSchemeVerifier"/>.
    /// </summary>
    public static Func<PaymentPayload, Task<VerifyResponse>> Create() =>
        payload => Task.FromResult(Verify(payload));

    /// <summary>Synchronous core of the verifier; public for unit testing.</summary>
    public static VerifyResponse Verify(PaymentPayload payload)
    {
        // 1. Scheme check
        if (payload.Accepted.Scheme != EvmSchemes.Exact)
            return Fail(EvmExactErrors.InvalidScheme, null);

        // 2. Parse scheme-specific payload
        var eip3009 = Eip3009Payload.FromJsonObject(payload.Payload);
        if (eip3009 is null)
            return Fail(EvmExactErrors.InvalidPayload, null);

        var auth = eip3009.Authorization;
        var payer = auth.From;

        // 3. Signature present
        if (string.IsNullOrEmpty(eip3009.Signature))
            return Fail(EvmExactErrors.MissingSignature, payer);

        // 4. EIP-712 domain fields
        var extra = payload.Accepted.Extra;
        if (extra is null
            || !extra.TryGetPropertyValue("name", out var nameNode) || nameNode is null
            || !extra.TryGetPropertyValue("version", out var verNode) || verNode is null)
            return Fail(EvmExactErrors.MissingEip712Domain, payer);

        var tokenName = nameNode.GetValue<string>();
        var tokenVersion = verNode.GetValue<string>();

        if (string.IsNullOrEmpty(tokenName) || string.IsNullOrEmpty(tokenVersion))
            return Fail(EvmExactErrors.MissingEip712Domain, payer);

        // 5. Recipient check
        if (!string.Equals(
                Eip712Hasher.NormalizeAddress(auth.To),
                Eip712Hasher.NormalizeAddress(payload.Accepted.PayTo),
                StringComparison.OrdinalIgnoreCase))
            return Fail(EvmExactErrors.RecipientMismatch, payer);

        // 6. Amount check
        if (!BigInteger.TryParse(auth.Value, out var authorizedAmt))
            return Fail(EvmExactErrors.InvalidPayload, payer);
        if (!BigInteger.TryParse(payload.Accepted.Amount, out var requiredAmt))
            return Fail(EvmExactErrors.InvalidRequiredAmount, payer);
        if (authorizedAmt != requiredAmt)
            return Fail(EvmExactErrors.AmountMismatch, payer);

        // 7. Timestamp window
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        if (!long.TryParse(auth.ValidBefore, out var validBefore))
            return Fail(EvmExactErrors.InvalidPayload, payer);
        if (validBefore < now + 6)          // must still be valid for at least 6 seconds
            return Fail(EvmExactErrors.ValidBeforeExpired, payer);

        if (!long.TryParse(auth.ValidAfter, out var validAfter))
            return Fail(EvmExactErrors.InvalidPayload, payer);
        if (validAfter > now)
            return Fail(EvmExactErrors.ValidAfterInFuture, payer);

        // 8. EIP-712 signature verification
        long chainId;
        try
        {
            chainId = Eip712Hasher.ChainIdFromCaip2(payload.Accepted.Network);
        }
        catch (FormatException)
        {
            return Fail(EvmExactErrors.InvalidNetworkFormat, payer);
        }

        byte[] messageHash;
        try
        {
            messageHash = Eip712Hasher.HashTransferWithAuthorization(
                from: auth.From,
                to: auth.To,
                value: auth.Value,
                validAfter: auth.ValidAfter,
                validBefore: auth.ValidBefore,
                nonce: auth.Nonce,
                chainId: chainId,
                verifyingContract: payload.Accepted.Asset,
                tokenName: tokenName,
                tokenVersion: tokenVersion);
        }
        catch
        {
            return Fail(EvmExactErrors.InvalidPayload, payer);
        }

        if (!EcdsaVerifier.Verify(messageHash, eip3009.Signature, auth.From))
            return Fail(EvmExactErrors.SignatureVerificationFailed, payer);

        return new VerifyResponse(true, null, payer);
    }

    private static VerifyResponse Fail(string reason, string? payer) =>
        new(false, reason, payer);
}
