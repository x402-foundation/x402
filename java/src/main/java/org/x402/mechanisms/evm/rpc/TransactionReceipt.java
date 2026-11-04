package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Hex;

import java.util.List;
import java.util.Objects;

/**
 * The receipt of a mined transaction, as returned by {@code eth_getTransactionReceipt}.
 *
 * @param transactionHash the {@code 0x}-prefixed 32-byte transaction hash
 * @param blockNumber the number of the block that included the transaction
 * @param successful {@code true} when the receipt status is 1, {@code false} when the transaction reverted
 *     (status 0)
 * @param logs the events the transaction emitted, in order; {@code null} when the signer does not report logs, in
 *     which case the exact scheme skips its {@code Transfer} event check
 */
public record TransactionReceipt(String transactionHash, long blockNumber, boolean successful, List<Log> logs) {

    /**
     * Creates a receipt, copying {@code logs}.
     *
     * @throws IllegalArgumentException if {@code transactionHash} is not 32 bytes of hex or {@code blockNumber}
     *     is negative
     */
    public TransactionReceipt {
        Objects.requireNonNull(transactionHash, "transactionHash");
        requireHex(transactionHash, 32, "transactionHash");
        if (blockNumber < 0) {
            throw new IllegalArgumentException("blockNumber must not be negative");
        }
        logs = logs == null ? null : List.copyOf(logs);
    }

    /**
     * One event in a receipt.
     *
     * @param address the contract that emitted the event
     * @param topics the indexed topics, each 32 bytes of {@code 0x}-prefixed hex; the first is the event signature
     *     hash, e.g. {@code keccak256("Transfer(address,address,uint256)")}
     * @param data the non-indexed event data as {@code 0x}-prefixed hex, possibly {@code "0x"}
     */
    public record Log(String address, List<String> topics, String data) {

        /**
         * Creates a log, copying {@code topics}.
         *
         * @throws IllegalArgumentException if {@code address} is not an address, a topic is not 32 bytes of hex or
         *     {@code data} is not hex
         */
        public Log {
            Objects.requireNonNull(address, "address");
            if (!EvmAddress.isValid(address)) {
                throw new IllegalArgumentException("log address is not an EVM address");
            }
            topics = List.copyOf(Objects.requireNonNull(topics, "topics"));
            for (String topic : topics) {
                requireHex(topic, 32, "log topic");
            }
            requireHex(Objects.requireNonNull(data, "data"), -1, "log data");
        }
    }

    private static void requireHex(String value, int length, String name) {
        try {
            if (length < 0) {
                Hex.decode(value);
            } else {
                Hex.decode(value, length);
            }
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(name + " must be hex" + (length < 0 ? "" : " of " + length + " bytes"),
                    e);
        }
    }
}
