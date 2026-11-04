package org.x402.mechanisms.evm;

import java.util.List;
import java.util.Map;

/**
 * The account a client pays from: an EVM address plus the ability to sign EIP-712 typed data with its key.
 *
 * <p>{@link PrivateKeyEvmSigner} implements this with an in-memory key. Implement it yourself to keep the key in
 * a KMS, an HSM or a remote wallet. Whatever holds the key must honor this contract exactly, otherwise the
 * facilitator rejects the payment:
 * <ol>
 *   <li><b>What is signed.</b> The 32-byte EIP-712 digest
 *       {@code keccak256(0x19 || 0x01 || domainSeparator(domain) || hashStruct(primaryType, message))}, as
 *       computed by {@link Eip712#hashTypedData}. The digest is signed directly with ECDSA over secp256k1; it is
 *       not hashed again and no EIP-191 {@code "\x19Ethereum Signed Message"} prefix is added. Services that
 *       accept the full typed data (e.g. {@code eth_signTypedData_v4}) compute the same digest themselves.</li>
 *   <li><b>Signature encoding.</b> Exactly 65 bytes {@code r || s || v}: {@code r} and {@code s} as 32-byte
 *       big-endian integers, {@code s} normalized to the lower half of the curve order ({@code s <= n/2},
 *       EIP-2), and {@code v} equal to {@code 27 + recoveryId}, i.e. 27 or 28. KMS services usually return a
 *       DER signature without {@code v}; convert it, normalize {@code s}, and find {@code v} by recovering the
 *       public key with {@link Secp256k1#recoverAddress(byte[], Secp256k1.Signature)}.</li>
 *   <li><b>Address.</b> {@link #address()} returns the {@code 0x}-prefixed EIP-55 checksummed address the
 *       signature recovers to: the last 20 bytes of {@code keccak256(X || Y)} of the uncompressed public key,
 *       as computed by {@link EvmAddress#fromPublicKey(byte[])}.</li>
 * </ol>
 *
 * <p>The EIP-3009 payment flow calls {@code signTypedData} with the token's domain (name, version, chain id and
 * token address), the {@code TransferWithAuthorization} fields from
 * {@link EvmConstants#TRANSFER_WITH_AUTHORIZATION_FIELDS} and a message whose values are in JSON form: addresses
 * and the {@code bytes32} nonce as {@code 0x} hex strings, integers as base-10 strings. That message can be
 * forwarded unchanged to a remote {@code eth_signTypedData_v4}.
 *
 * <p>Implementations must be thread-safe: one signer instance is shared by concurrent requests.
 */
public interface ClientEvmSigner {

    /**
     * Returns the address payments are made from.
     *
     * @return the {@code 0x}-prefixed EIP-55 checksummed address, never {@code null}
     */
    String address();

    /**
     * Signs EIP-712 typed data with the account's key.
     *
     * @param domain the signing domain
     * @param types the fields of {@code primaryType}, in declaration order; only flat structs are used
     * @param primaryType the name of the signed struct, e.g. {@code "TransferWithAuthorization"}
     * @param message the field values; see {@link Eip712} for the accepted value types
     * @return a new 65-byte {@code r || s || v} signature with low {@code s} and {@code v} of 27 or 28
     * @throws IllegalArgumentException if the typed data is malformed
     * @throws RuntimeException if the key holder fails, e.g. an {@link java.io.UncheckedIOException} when a
     *     remote signer is unreachable; callers treat any runtime exception as a signing failure
     */
    byte[] signTypedData(
            TypedDataDomain domain, List<TypedDataField> types, String primaryType, Map<String, Object> message);
}
