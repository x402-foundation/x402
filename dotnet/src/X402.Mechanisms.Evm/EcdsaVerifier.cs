using Nethereum.Signer;
using Nethereum.Util;

namespace X402.Mechanisms.Evm;

/// <summary>
/// ECDSA signature verification for Ethereum (secp256k1).
/// </summary>
public static class EcdsaVerifier
{
    /// <summary>
    /// Recovers the Ethereum address that produced <paramref name="signature"/> over
    /// <paramref name="messageHash"/>.
    /// </summary>
    /// <param name="messageHash">32-byte EIP-712 digest.</param>
    /// <param name="signature">
    ///   65-byte signature, hex-encoded, optionally 0x-prefixed.
    ///   Byte layout: r (32 bytes) + s (32 bytes) + v (1 byte).
    ///   <c>v</c> may be 0/1 or 27/28.
    /// </param>
    /// <returns>Checksummed Ethereum address (lower-case "0x…"), or <c>null</c> on failure.</returns>
    public static string? RecoverAddress(byte[] messageHash, string signature)
    {
        try
        {
            var sigBytes = HexToBytes(signature);
            if (sigBytes.Length != 65) return null;

            // Adjust v for Nethereum recovery (expects 27/28 in the byte[] form)
            var v = sigBytes[64];
            if (v < 27) v += 27;

            var sig = new EthECDSASignature(
                new Org.BouncyCastle.Math.BigInteger(1, sigBytes[..32]),
                new Org.BouncyCastle.Math.BigInteger(1, sigBytes[32..64]),
                new byte[] { v });

            var key = EthECKey.RecoverFromSignature(sig, messageHash);
            return key.GetPublicAddress().ToLowerInvariant();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Verifies that <paramref name="signature"/> was produced by <paramref name="expectedAddress"/>
    /// over <paramref name="messageHash"/>.
    /// </summary>
    public static bool Verify(byte[] messageHash, string signature, string expectedAddress)
    {
        var recovered = RecoverAddress(messageHash, signature);
        if (recovered is null) return false;

        return string.Equals(
            Normalize(recovered),
            Normalize(expectedAddress),
            StringComparison.OrdinalIgnoreCase);
    }

    private static string Normalize(string address) =>
        address.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? address : "0x" + address;

    private static byte[] HexToBytes(string hex)
    {
        var s = hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? hex[2..] : hex;
        if (s.Length % 2 != 0) s = "0" + s;
        var result = new byte[s.Length / 2];
        for (var i = 0; i < result.Length; i++)
            result[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
        return result;
    }
}
