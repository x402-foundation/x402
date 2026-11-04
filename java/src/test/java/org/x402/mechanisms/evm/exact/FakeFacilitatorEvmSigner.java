package org.x402.mechanisms.evm.exact;

import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.rpc.FacilitatorEvmSigner;
import org.x402.mechanisms.evm.rpc.TransactionReceipt;

import java.io.IOException;
import java.math.BigInteger;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A scriptable {@link FacilitatorEvmSigner} for unit tests: tests set the chain state and failures through the
 * public fields, and inspect the recorded calls afterwards. Not thread-safe.
 */
final class FakeFacilitatorEvmSigner implements FacilitatorEvmSigner {

    /** Answers {@code eth_call}s; the default returns empty data, i.e. a successful simulation. */
    @FunctionalInterface
    interface CallHandler {
        byte[] call(String to, byte[] data) throws IOException;
    }

    static final String FACILITATOR = "0xFaC1000000000000000000000000000000000001";

    BigInteger chainId = BigInteger.valueOf(84532);
    final Map<String, byte[]> codes = new HashMap<>();
    final Map<String, IOException> codeFailures = new HashMap<>();
    CallHandler callHandler = (to, data) -> new byte[0];
    String sentHash = "0x" + "ab".repeat(32);
    IOException sendFailure;
    TransactionReceipt receipt;
    IOException receiptFailure;
    /** Failures of the next receipt waits, one per wait, before {@link #receiptFailure} applies. */
    final Deque<IOException> nextReceiptFailures = new ArrayDeque<>();
    boolean interruptReceiptWait;

    final List<String> codeRequests = new ArrayList<>();
    final List<String> calls = new ArrayList<>();
    final List<String> sent = new ArrayList<>();
    final List<String> receiptWaits = new ArrayList<>();
    Duration receiptTimeout;

    /** Gives an address bytecode. */
    FakeFacilitatorEvmSigner withCode(String address, String code) {
        codes.put(key(address), Hex.decode(code));
        return this;
    }

    /** Returns the selectors of the {@code eth_call}s made, in order. */
    List<String> calledSelectors() {
        List<String> selectors = new ArrayList<>();
        for (String call : calls) {
            selectors.add(call.substring(call.indexOf(' ') + 1, call.indexOf(' ') + 11));
        }
        return selectors;
    }

    @Override
    public List<String> addresses() {
        return List.of(FACILITATOR);
    }

    @Override
    public BigInteger chainId() {
        return chainId;
    }

    @Override
    public byte[] call(String to, byte[] data) throws IOException {
        calls.add(key(to) + " " + Hex.encode(data));
        return callHandler.call(to, data);
    }

    @Override
    public byte[] getCode(String address) throws IOException {
        codeRequests.add(key(address));
        IOException failure = codeFailures.get(key(address));
        if (failure != null) {
            throw failure;
        }
        return codes.getOrDefault(key(address), new byte[0]).clone();
    }

    @Override
    public String sendTransaction(String to, byte[] data) throws IOException {
        sent.add(key(to) + " " + Hex.encode(data));
        if (sendFailure != null) {
            throw sendFailure;
        }
        return sentHash;
    }

    @Override
    public TransactionReceipt waitForReceipt(String transactionHash, Duration timeout)
            throws IOException, InterruptedException {
        receiptTimeout = timeout;
        receiptWaits.add(transactionHash);
        if (interruptReceiptWait) {
            throw new InterruptedException("test interrupt");
        }
        IOException next = nextReceiptFailures.poll();
        if (next != null) {
            throw next;
        }
        if (receiptFailure != null) {
            throw receiptFailure;
        }
        return receipt;
    }

    static String key(String address) {
        return Hex.encode(EvmAddress.toBytes(address)).toLowerCase(Locale.ROOT);
    }
}
