package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Keccak;
import org.x402.mechanisms.evm.Secp256k1;
import org.x402.mechanisms.evm.Uint256;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * An unsigned EIP-1559 (type 2) transaction with an empty access list.
 *
 * <p>The signer signs {@link #signingHash()}, {@code keccak256(0x02 || rlp([chainId, nonce, maxPriorityFeePerGas,
 * maxFeePerGas, gasLimit, to, value, data, accessList]))}. The raw transaction broadcast with
 * {@code eth_sendRawTransaction} is {@code 0x02 || rlp([..., accessList, yParity, r, s])}, see
 * {@link #encodeSigned(Secp256k1.Signature)}, and its hash is the Keccak-256 of those bytes.
 *
 * <p>Instances are immutable and thread-safe.
 */
final class Eip1559Transaction {

    /** The EIP-2718 type byte of EIP-1559 transactions. */
    static final byte TYPE = 0x02;

    /** EIP-2681 caps the nonce, and every client caps the gas limit, at {@code 2^64 - 1}. */
    private static final BigInteger MAX_UINT64 = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);
    private static final byte[] EMPTY_ACCESS_LIST = Rlp.encodeList(List.of());

    private final BigInteger chainId;
    private final BigInteger nonce;
    private final BigInteger maxPriorityFeePerGas;
    private final BigInteger maxFeePerGas;
    private final BigInteger gasLimit;
    private final byte[] to;
    private final BigInteger value;
    private final byte[] data;

    /**
     * Creates a transaction.
     *
     * @param chainId the EIP-155 chain id, positive
     * @param nonce the sender's nonce, at most {@code 2^64 - 1}
     * @param maxPriorityFeePerGas the tip per gas in wei
     * @param maxFeePerGas the fee cap per gas in wei, at least {@code maxPriorityFeePerGas}
     * @param gasLimit the gas limit, positive and at most {@code 2^64 - 1}
     * @param to the recipient or called contract
     * @param value the wei sent along
     * @param data the calldata, copied
     * @throws IllegalArgumentException if a value is out of range or {@code to} is not an address
     */
    Eip1559Transaction(
            BigInteger chainId,
            BigInteger nonce,
            BigInteger maxPriorityFeePerGas,
            BigInteger maxFeePerGas,
            BigInteger gasLimit,
            String to,
            BigInteger value,
            byte[] data) {
        this.chainId = requirePositive(requireUint256(chainId, "chainId"), "chainId");
        this.nonce = requireUint64(nonce, "nonce");
        this.maxPriorityFeePerGas = requireUint256(maxPriorityFeePerGas, "maxPriorityFeePerGas");
        this.maxFeePerGas = requireUint256(maxFeePerGas, "maxFeePerGas");
        this.gasLimit = requirePositive(requireUint64(gasLimit, "gasLimit"), "gasLimit");
        this.to = EvmAddress.toBytes(Objects.requireNonNull(to, "to"));
        this.value = requireUint256(value, "value");
        this.data = Objects.requireNonNull(data, "data").clone();
        if (maxFeePerGas.compareTo(maxPriorityFeePerGas) < 0) {
            throw new IllegalArgumentException("maxFeePerGas must be at least maxPriorityFeePerGas");
        }
    }

    /**
     * Returns the hash the sender signs: {@code keccak256(0x02 || rlp(unsigned fields))}.
     *
     * @return the 32-byte signing hash
     */
    byte[] signingHash() {
        return Keccak.keccak256(new byte[] {TYPE}, Rlp.encodeList(fields()));
    }

    /**
     * Serializes the transaction with its signature, ready for {@code eth_sendRawTransaction}.
     *
     * @param signature the signature over {@link #signingHash()}; its recovery id becomes {@code yParity}
     * @return {@code 0x02 || rlp([..., yParity, r, s])}
     */
    byte[] encodeSigned(Secp256k1.Signature signature) {
        Objects.requireNonNull(signature, "signature");
        List<byte[]> fields = fields();
        fields.add(Rlp.encodeInteger(BigInteger.valueOf(signature.recoveryId())));
        fields.add(Rlp.encodeInteger(signature.r()));
        fields.add(Rlp.encodeInteger(signature.s()));
        byte[] list = Rlp.encodeList(fields);
        byte[] out = new byte[list.length + 1];
        out[0] = TYPE;
        System.arraycopy(list, 0, out, 1, list.length);
        return out;
    }

    private List<byte[]> fields() {
        List<byte[]> fields = new ArrayList<>(12);
        fields.add(Rlp.encodeInteger(chainId));
        fields.add(Rlp.encodeInteger(nonce));
        fields.add(Rlp.encodeInteger(maxPriorityFeePerGas));
        fields.add(Rlp.encodeInteger(maxFeePerGas));
        fields.add(Rlp.encodeInteger(gasLimit));
        fields.add(Rlp.encodeString(to));
        fields.add(Rlp.encodeInteger(value));
        fields.add(Rlp.encodeString(data));
        fields.add(EMPTY_ACCESS_LIST);
        return fields;
    }

    private static BigInteger requireUint256(BigInteger value, String name) {
        Objects.requireNonNull(value, name);
        try {
            return Uint256.requireInRange(value);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(name + " must be a uint256", e);
        }
    }

    private static BigInteger requireUint64(BigInteger value, String name) {
        Objects.requireNonNull(value, name);
        if (value.signum() < 0 || value.compareTo(MAX_UINT64) > 0) {
            throw new IllegalArgumentException(name + " must be between 0 and 2^64 - 1");
        }
        return value;
    }

    private static BigInteger requirePositive(BigInteger value, String name) {
        if (value.signum() <= 0) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return value;
    }
}
