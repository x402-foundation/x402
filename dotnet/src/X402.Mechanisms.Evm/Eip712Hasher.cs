using System.Numerics;
using System.Text;
using Nethereum.ABI;
using Nethereum.ABI.FunctionEncoding.Attributes;
using Nethereum.Util;

namespace X402.Mechanisms.Evm;

/// <summary>
/// Pure .NET implementation of EIP-712 typed-data hashing.
///
/// Produces the 32-byte digest used to verify (or create) structured signatures:
///   keccak256( "\x19\x01" + domainSeparator + structHash )
/// </summary>
public static class Eip712Hasher
{
    // ──────────────────────────────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Hashes an EIP-3009 <c>TransferWithAuthorization</c> message.
    ///
    /// <para>This is the hash that the payer signs with their private key.</para>
    /// </summary>
    /// <param name="from">Sender Ethereum address.</param>
    /// <param name="to">Recipient Ethereum address.</param>
    /// <param name="value">Token amount (integer string).</param>
    /// <param name="validAfter">Unix timestamp string.</param>
    /// <param name="validBefore">Unix timestamp string.</param>
    /// <param name="nonce">Hex-encoded 32-byte nonce.</param>
    /// <param name="chainId">Numeric chain ID.</param>
    /// <param name="verifyingContract">Token contract address.</param>
    /// <param name="tokenName">EIP-712 domain <c>name</c> field (e.g. "USD Coin").</param>
    /// <param name="tokenVersion">EIP-712 domain <c>version</c> field (e.g. "2").</param>
    /// <returns>32-byte EIP-712 digest.</returns>
    public static byte[] HashTransferWithAuthorization(
        string from,
        string to,
        string value,
        string validAfter,
        string validBefore,
        string nonce,
        long chainId,
        string verifyingContract,
        string tokenName,
        string tokenVersion)
    {
        var typeHash = TypeHash(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

        var structHash = StructHash(
            typeHash,
            ("address", (object)NormalizeAddress(from)),
            ("address", (object)NormalizeAddress(to)),
            ("uint256", (object)ParseBigInt(value)),
            ("uint256", (object)ParseBigInt(validAfter)),
            ("uint256", (object)ParseBigInt(validBefore)),
            ("bytes32", (object)HexToBytes32(nonce)));

        var domainSeparator = BuildDomainSeparator(tokenName, tokenVersion, chainId, verifyingContract);

        return FinalDigest(domainSeparator, structHash);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Internals
    // ──────────────────────────────────────────────────────────────────────

    private static readonly Sha3Keccack _keccak = new();

    private static byte[] Keccak256(byte[] data) =>
        _keccak.CalculateHash(data);

    private static byte[] Keccak256(string text) =>
        Keccak256(Encoding.UTF8.GetBytes(text));

    /// <summary>typeHash = keccak256(typeString)</summary>
    private static byte[] TypeHash(string typeString) =>
        Keccak256(typeString);

    /// <summary>Compute keccak256( abi.encode(typeHash, field1, field2, …) ).</summary>
    private static byte[] StructHash(byte[] typeHash, params (string SolidityType, object Value)[] fields)
    {
        // ABI-encode: [typeHash (bytes32)] [field1] [field2] …
        var encoder = new ABIEncode();
        var parameters = new List<ABIValue>();

        parameters.Add(new ABIValue("bytes32", typeHash));
        foreach (var (solidityType, value) in fields)
            parameters.Add(new ABIValue(solidityType, value));

        var encoded = encoder.GetABIEncoded(parameters.ToArray());
        return Keccak256(encoded);
    }

    /// <summary>domainSeparator = keccak256( abi.encode(domainTypeHash, name, version, chainId, verifyingContract) )</summary>
    private static byte[] BuildDomainSeparator(
        string name, string version, long chainId, string verifyingContract)
    {
        var domainTypeHash = TypeHash(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

        var nameHash = Keccak256(name);
        var versionHash = Keccak256(version);

        var encoder = new ABIEncode();
        var encoded = encoder.GetABIEncoded(new[]
        {
            new ABIValue("bytes32", domainTypeHash),
            new ABIValue("bytes32", nameHash),
            new ABIValue("bytes32", versionHash),
            new ABIValue("uint256", new BigInteger(chainId)),
            new ABIValue("address", NormalizeAddress(verifyingContract)),
        });
        return Keccak256(encoded);
    }

    /// <summary>digest = keccak256( "\x19\x01" + domainSeparator + structHash )</summary>
    private static byte[] FinalDigest(byte[] domainSeparator, byte[] structHash)
    {
        var raw = new byte[2 + 32 + 32];
        raw[0] = 0x19;
        raw[1] = 0x01;
        Buffer.BlockCopy(domainSeparator, 0, raw, 2, 32);
        Buffer.BlockCopy(structHash, 0, raw, 34, 32);
        return Keccak256(raw);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────

    internal static string NormalizeAddress(string address) =>
        address.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? address.ToLowerInvariant()
            : "0x" + address.ToLowerInvariant();

    internal static BigInteger ParseBigInt(string value)
    {
        if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            return BigInteger.Parse(value[2..], System.Globalization.NumberStyles.HexNumber);
        return BigInteger.Parse(value);
    }

    internal static byte[] HexToBytes32(string hex)
    {
        var s = hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? hex[2..] : hex;
        // Pad to 32 bytes (64 hex chars)
        s = s.PadLeft(64, '0');
        var bytes = new byte[32];
        for (var i = 0; i < 32; i++)
            bytes[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
        return bytes;
    }

    internal static long ChainIdFromCaip2(string network)
    {
        // e.g. "eip155:84532" → 84532
        var idx = network.IndexOf(':');
        if (idx < 0 || !long.TryParse(network[(idx + 1)..], out var id))
            throw new FormatException($"Cannot parse chain ID from CAIP-2 network: '{network}'");
        return id;
    }
}
