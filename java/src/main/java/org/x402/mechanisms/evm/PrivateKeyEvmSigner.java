package org.x402.mechanisms.evm;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * A {@link ClientEvmSigner} backed by a secp256k1 private key held in memory.
 *
 * <pre>{@code
 * ClientEvmSigner signer = PrivateKeyEvmSigner.fromHex(System.getenv("EVM_PRIVATE_KEY"));
 * signer.address(); // "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" for anvil's first key
 * }</pre>
 *
 * <p>Signatures are deterministic (RFC 6979) and low-s, see {@link Secp256k1}. The key is never exposed:
 * there is no accessor and {@link #toString()} prints only the address. Instances are immutable and
 * thread-safe.
 */
public final class PrivateKeyEvmSigner implements ClientEvmSigner {

    private final BigInteger privateKey;
    private final String address;

    private PrivateKeyEvmSigner(BigInteger privateKey) {
        this.privateKey = privateKey;
        this.address = EvmAddress.fromPublicKey(Secp256k1.publicKey(privateKey));
    }

    /**
     * Creates a signer from a hex-encoded private key.
     *
     * @param privateKeyHex the 32-byte key as 64 hex digits, with or without a {@code 0x} prefix
     * @return the signer
     * @throws IllegalArgumentException if the key is malformed or outside the secp256k1 range; the message
     *     never contains the key
     */
    public static PrivateKeyEvmSigner fromHex(String privateKeyHex) {
        Objects.requireNonNull(privateKeyHex, "privateKeyHex");
        return new PrivateKeyEvmSigner(Secp256k1.parsePrivateKey(privateKeyHex));
    }

    @Override
    public String address() {
        return address;
    }

    @Override
    public byte[] signTypedData(
            TypedDataDomain domain, List<TypedDataField> types, String primaryType, Map<String, Object> message) {
        return signDigest(Eip712.hashTypedData(domain, types, primaryType, message)).toBytes();
    }

    /**
     * Signs a precomputed 32-byte digest, e.g. the hash of an unsigned EIP-1559 transaction.
     *
     * <p>The digest is signed as is, so whoever controls its bytes controls what the key authorizes. Only pass
     * digests the application computed itself.
     *
     * @param digest the 32-byte digest
     * @return the low-s signature with its recovery id
     * @throws IllegalArgumentException if {@code digest} is not 32 bytes
     */
    public Secp256k1.Signature signDigest(byte[] digest) {
        return Secp256k1.sign(digest, privateKey);
    }

    @Override
    public String toString() {
        return "PrivateKeyEvmSigner[address=" + address + "]";
    }
}
