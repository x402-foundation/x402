package org.x402.mechanisms.evm.rpc;

import java.io.IOException;
import java.math.BigInteger;
import java.time.Duration;
import java.util.List;

/**
 * The facilitator's account on one EVM chain: reads chain state and sends the settlement transactions the exact
 * scheme builds.
 *
 * <p>{@link JsonRpcFacilitatorEvmSigner} implements this over Ethereum JSON-RPC with an in-memory key. Implement it
 * yourself to sign with a KMS or HSM, or to reuse an existing client library. The exact scheme relies on this
 * contract:
 * <ol>
 *   <li><b>One chain.</b> Every method acts on the chain whose EIP-155 id is {@link #chainId()}. The scheme rejects
 *       payments for any other network with {@code invalid_exact_evm_failed_to_get_network_config}.</li>
 *   <li><b>Addresses.</b> {@link #addresses()} lists the {@code 0x}-prefixed EIP-55 addresses that sign
 *       transactions; they are advertised in {@code /supported}. Reads and transactions are sent from the first
 *       one.</li>
 *   <li><b>Transactions.</b> {@link #sendTransaction(String, byte[])} sends a zero-value call. The implementation
 *       chooses the nonce, the gas limit and the fees, signs with secp256k1 over the transaction's signing hash (for
 *       EIP-1559, {@code keccak256(0x02 || rlp(fields))}) and must never give two concurrent sends the same
 *       nonce.</li>
 *   <li><b>Reverts.</b> A call or gas estimation that the EVM reverted is reported as a
 *       {@link ContractRevertException} whose message carries the revert reason when the node returns one, e.g.
 *       {@code "execution reverted: FiatTokenV2: invalid signature"}. Any other {@link IOException} means the
 *       chain could not be queried and says nothing about the call.</li>
 * </ol>
 *
 * <p>Addresses are passed as {@code 0x}-prefixed hex in any letter case. Implementations must be thread-safe: one
 * instance serves concurrent verify and settle requests.
 */
public interface FacilitatorEvmSigner {

    /**
     * Returns the addresses this facilitator signs settlement transactions with.
     *
     * @return a non-empty, unmodifiable list of {@code 0x}-prefixed EIP-55 checksummed addresses
     */
    List<String> addresses();

    /**
     * Returns the EIP-155 id of the chain this signer is connected to.
     *
     * @return the chain id, e.g. {@code 84532} for Base Sepolia
     */
    BigInteger chainId();

    /**
     * Executes a read-only call ({@code eth_call}) against the latest block, sent from {@code addresses().get(0)}.
     * Nothing is broadcast.
     *
     * @param to the contract to call
     * @param data the calldata
     * @return the returned data, possibly empty
     * @throws ContractRevertException if the call reverted
     * @throws IOException if the chain cannot be queried or the response is malformed
     * @throws InterruptedException if the calling thread is interrupted
     */
    byte[] call(String to, byte[] data) throws IOException, InterruptedException;

    /**
     * Returns the bytecode deployed at an address in the latest block.
     *
     * @param address the account
     * @return the code, empty for an externally owned account or an unused address
     * @throws IOException if the chain cannot be queried or the response is malformed
     * @throws InterruptedException if the calling thread is interrupted
     */
    byte[] getCode(String address) throws IOException, InterruptedException;

    /**
     * Signs and broadcasts a transaction from {@code addresses().get(0)} that calls {@code to} with {@code data}
     * and no value. Returns once the node accepted the transaction, without waiting for it to be mined.
     *
     * @param to the contract to call
     * @param data the calldata
     * @return the {@code 0x}-prefixed 32-byte transaction hash
     * @throws ContractRevertException if gas estimation shows the call would revert; nothing was broadcast
     * @throws BroadcastOutcomeUnknownException if the transaction was handed to the node but its answer was lost,
     *     so it may still be mined; the exception carries its hash
     * @throws IOException if the transaction could not be built, signed or broadcast
     * @throws InterruptedException if the calling thread is interrupted before the transaction is broadcast
     */
    String sendTransaction(String to, byte[] data) throws IOException, InterruptedException;

    /**
     * Waits until a transaction is mined and returns its receipt.
     *
     * @param transactionHash the {@code 0x}-prefixed 32-byte hash returned by
     *     {@link #sendTransaction(String, byte[])}
     * @param timeout how long to wait at most; implementations must honor it so a stuck node cannot block a
     *     settlement indefinitely
     * @return the receipt, which may report a reverted transaction
     * @throws IllegalArgumentException if {@code transactionHash} is not 32 bytes of hex or {@code timeout} is
     *     negative
     * @throws IOException if no receipt was found within {@code timeout} or the chain kept failing; the transaction
     *     may still be mined later
     * @throws InterruptedException if the calling thread is interrupted
     */
    TransactionReceipt waitForReceipt(String transactionHash, Duration timeout)
            throws IOException, InterruptedException;
}
