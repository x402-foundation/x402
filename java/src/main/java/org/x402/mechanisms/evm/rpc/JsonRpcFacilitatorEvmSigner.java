package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.EvmNetworks;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Keccak;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.math.BigInteger;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * A {@link FacilitatorEvmSigner} that talks to an Ethereum node over JSON-RPC and signs EIP-1559 transactions with
 * an in-memory key.
 *
 * <pre>{@code
 * FacilitatorEvmSigner signer = JsonRpcFacilitatorEvmSigner
 *         .builder("eip155:84532", URI.create("https://sepolia.base.org"),
 *                 PrivateKeyEvmSigner.fromHex(System.getenv("FACILITATOR_EVM_PRIVATE_KEY")))
 *         .requestTimeout(Duration.ofSeconds(15))
 *         .connect(); // checks that eth_chainId is 84532
 * }</pre>
 *
 * <p>{@link #sendTransaction(String, byte[])} builds a type 2 transaction from the node's view of the chain:
 * <ul>
 *   <li>{@code gasLimit}: {@code eth_estimateGas} plus {@value #GAS_MARGIN_PERCENT}%; a reverting estimate is
 *       reported as {@link ContractRevertException} and nothing is sent;</li>
 *   <li>{@code maxPriorityFeePerGas}: {@code eth_maxPriorityFeePerGas};</li>
 *   <li>{@code maxFeePerGas}: {@code 2 * baseFeePerGas + maxPriorityFeePerGas}, with the base fee of the latest
 *       block, so the transaction stays includable while the base fee doubles;</li>
 *   <li>{@code nonce}: {@code eth_getTransactionCount(address, "pending")}, or one past the last nonce this
 *       instance broadcast if that is higher, so a load-balanced node that lags behind cannot cause nonce reuse.
 *       If the node's pending nonce stays at the same value below that floor for two minutes, the transaction
 *       holding it is assumed dropped and its nonce is used again, so one lost transaction cannot stall every
 *       later one.</li>
 * </ul>
 * It signs {@code keccak256(0x02 || rlp(fields))}, broadcasts with {@code eth_sendRawTransaction} and returns the
 * locally computed hash, logging a reply that reports another one. A lock held from the nonce lookup to the
 * broadcast serializes sends, so concurrent settlements never share a nonce. A send that cannot connect, or that
 * the node rejects with a JSON-RPC error or an HTTP 4xx status, does not consume its nonce. Nor does a send whose
 * outcome is unknown, such as a timed-out reply, a 5xx status, a connection dropped after sending or an interrupt:
 * it is reported as a {@link BroadcastOutcomeUnknownException} carrying the hash, and if the node did accept it, a
 * lagging node can hand its nonce to the next send, which the network then rejects or treats as a replacement.
 * Use a single instance per key and chain: two instances sending from the same key on the same chain coordinate
 * only through the node's pending nonce.
 *
 * <p>{@link #waitForReceipt(String, Duration)} polls {@code eth_getTransactionReceipt} until the timeout, bounding
 * each poll by the time left.
 *
 * <p>Reverts reported by {@code eth_call} and {@code eth_estimateGas}, JSON-RPC error code {@code 3} or a message
 * containing "revert", become {@link ContractRevertException}s whose message includes the decoded
 * {@code Error(string)} reason. The private key never leaves the {@link PrivateKeyEvmSigner}; {@link #toString()}
 * shows the address and chain id only, never the key or the endpoint URL, which often embeds an API key.
 *
 * <p>Instances are thread-safe.
 */
public final class JsonRpcFacilitatorEvmSigner implements FacilitatorEvmSigner {

    /** Default timeout of each JSON-RPC request. */
    public static final Duration DEFAULT_REQUEST_TIMEOUT = Duration.ofSeconds(30);

    /** Default delay between two {@code eth_getTransactionReceipt} polls. */
    public static final Duration DEFAULT_RECEIPT_POLL_INTERVAL = Duration.ofSeconds(1);

    /** Headroom added to {@code eth_estimateGas}, in percent. */
    public static final int GAS_MARGIN_PERCENT = 20;

    /** How long the node's pending nonce may stay at the same value below the local floor before the floor drops. */
    static final Duration NONCE_RESYNC_AFTER = Duration.ofMinutes(2);

    private static final System.Logger LOGGER = System.getLogger(JsonRpcFacilitatorEvmSigner.class.getName());
    private static final int EXECUTION_REVERTED = 3;
    private static final BigInteger HUNDRED = BigInteger.valueOf(100);

    private final JsonRpcClient rpc;
    private final PrivateKeyEvmSigner key;
    private final String rpcAddress;
    private final BigInteger chainId;
    private final Duration receiptPollInterval;
    private final TimeSource time;
    private final ReentrantLock sendLock = new ReentrantLock();
    /** One past the highest nonce this instance broadcast; guarded by {@link #sendLock}. */
    private BigInteger nextNonce = BigInteger.ZERO;
    /** The node's pending nonce while it is below {@link #nextNonce}, else {@code null}; guarded by sendLock. */
    private BigInteger stalledNonce;
    /** When the node first reported {@link #stalledNonce}, from {@link TimeSource#nanoTime()}; guarded by sendLock. */
    private long stalledSince;

    private JsonRpcFacilitatorEvmSigner(JsonRpcClient rpc, PrivateKeyEvmSigner key, BigInteger chainId,
            Duration receiptPollInterval, TimeSource time) {
        this.rpc = rpc;
        this.key = key;
        this.rpcAddress = key.address().toLowerCase(Locale.ROOT);
        this.chainId = chainId;
        this.receiptPollInterval = receiptPollInterval;
        this.time = time;
    }

    /**
     * Starts building a signer.
     *
     * @param network the CAIP-2 network the endpoint serves, e.g. {@code "eip155:84532"}
     * @param rpcUrl the node's {@code http} or {@code https} JSON-RPC endpoint
     * @param key the facilitator's key; transactions are sent from its address
     * @return a builder
     * @throws IllegalArgumentException if {@code network} is not an {@code eip155:<chainId>} network or
     *     {@code rpcUrl} is not an absolute HTTP(S) URI
     */
    public static Builder builder(String network, URI rpcUrl, PrivateKeyEvmSigner key) {
        return new Builder(network, rpcUrl, key);
    }

    @Override
    public List<String> addresses() {
        return List.of(key.address());
    }

    @Override
    public BigInteger chainId() {
        return chainId;
    }

    @Override
    public byte[] call(String to, byte[] data) throws IOException, InterruptedException {
        Map<String, Object> call = callObject(to, data);
        try {
            return JsonRpcClient.decodeData(rpc.call("eth_call", List.of(call, "latest")), "eth_call result");
        } catch (JsonRpcException e) {
            throw asRevert(e);
        }
    }

    @Override
    public byte[] getCode(String address) throws IOException, InterruptedException {
        JsonNode code = rpc.call("eth_getCode", List.of(rpcAddress(address, "address"), "latest"));
        return JsonRpcClient.decodeData(code, "eth_getCode result");
    }

    @Override
    public String sendTransaction(String to, byte[] data) throws IOException, InterruptedException {
        Map<String, Object> call = callObject(to, data);
        // Neither the gas limit nor the fees depend on the nonce, so they are read before taking the lock
        BigInteger gasLimit = withMargin(estimateGas(call));
        BigInteger tip = JsonRpcClient.decodeQuantity(
                rpc.call("eth_maxPriorityFeePerGas", List.of()), "eth_maxPriorityFeePerGas");
        BigInteger maxFee = latestBaseFee().multiply(BigInteger.TWO).add(tip);
        sendLock.lockInterruptibly();
        try {
            BigInteger pending = JsonRpcClient.decodeQuantity(
                    rpc.call("eth_getTransactionCount", List.of(rpcAddress, "pending")), "eth_getTransactionCount");
            BigInteger nonce = chooseNonce(pending);

            Eip1559Transaction transaction;
            try {
                transaction = new Eip1559Transaction(
                        chainId, nonce, tip, maxFee, gasLimit, to, BigInteger.ZERO, data);
            } catch (IllegalArgumentException e) {
                throw new IOException("Node returned out-of-range transaction parameters: " + e.getMessage(), e);
            }
            byte[] raw = transaction.encodeSigned(key.signDigest(transaction.signingHash()));
            String hash = Hex.encode(Keccak.keccak256(raw));
            JsonNode accepted = broadcast(raw, hash);
            nextNonce = nonce.add(BigInteger.ONE);
            checkReportedHash(accepted, hash);
            return hash;
        } finally {
            sendLock.unlock();
        }
    }

    @Override
    public TransactionReceipt waitForReceipt(String transactionHash, Duration timeout)
            throws IOException, InterruptedException {
        Objects.requireNonNull(transactionHash, "transactionHash");
        Objects.requireNonNull(timeout, "timeout");
        String hash = Hex.encode(Hex.decode(transactionHash, 32));
        if (timeout.isNegative()) {
            throw new IllegalArgumentException("timeout must not be negative");
        }
        long deadline = time.nanoTime() + timeout.toNanos();
        long remaining = timeout.toNanos();
        IOException lastFailure = null;
        while (remaining > 0) {
            try {
                JsonNode receipt = rpc.call("eth_getTransactionReceipt", List.of(hash), Duration.ofNanos(remaining));
                if (!receipt.isNull()) {
                    return parseReceipt(receipt, hash);
                }
            } catch (IOException e) {
                // Keep polling: a load-balanced node may briefly fail or not know the transaction yet
                lastFailure = e;
                LOGGER.log(System.Logger.Level.DEBUG, "Receipt poll for {0} failed: {1}", hash, e.getMessage());
            }
            remaining = deadline - time.nanoTime();
            if (remaining > 0) {
                time.sleep(Math.min(receiptPollInterval.toNanos(), remaining));
                remaining = deadline - time.nanoTime();
            }
        }
        String detail = lastFailure == null ? "" : "; last error: " + lastFailure.getMessage();
        throw new IOException("No receipt for " + hash + " within " + timeout + detail, lastFailure);
    }

    @Override
    public String toString() {
        return "JsonRpcFacilitatorEvmSigner[address=" + key.address() + ", chainId=" + chainId + "]";
    }

    /**
     * Returns the nonce of the next transaction: the node's pending nonce, or the local floor if that is higher,
     * unless the pending nonce has stayed at the same value below the floor for {@link #NONCE_RESYNC_AFTER}. The
     * caller holds {@link #sendLock}.
     */
    private BigInteger chooseNonce(BigInteger pending) {
        if (pending.compareTo(nextNonce) >= 0) {
            stalledNonce = null;
            return pending;
        }
        long now = time.nanoTime();
        if (!pending.equals(stalledNonce)) {
            // The node is behind, or still catching up: keep the floor and restart the clock
            stalledNonce = pending;
            stalledSince = now;
            return nextNonce;
        }
        if (now - stalledSince < NONCE_RESYNC_AFTER.toNanos()) {
            return nextNonce;
        }
        LOGGER.log(System.Logger.Level.WARNING,
                "Pending nonce of {0} stuck at {1}, below {2}, for {3}: assuming its transaction was dropped",
                key.address(), pending, nextNonce, NONCE_RESYNC_AFTER);
        nextNonce = pending;
        stalledNonce = null;
        return pending;
    }

    /**
     * Sends a signed transaction. A failure to connect, a JSON-RPC error or an HTTP 4xx status means the node did
     * not take it; any other failure, e.g. a timeout, a 5xx status, a dropped connection or an interrupt, leaves the
     * outcome unknown.
     */
    private JsonNode broadcast(byte[] raw, String hash) throws IOException {
        try {
            return rpc.call("eth_sendRawTransaction", List.of(Hex.encode(raw)));
        } catch (IOException e) {
            if (notTaken(e)) {
                throw e;
            }
            throw new BroadcastOutcomeUnknownException(
                    hash, e.getMessage() + "; transaction " + hash + " may still be mined", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BroadcastOutcomeUnknownException(
                    hash, "eth_sendRawTransaction: interrupted; transaction " + hash + " may still be mined", e);
        }
    }

    /** Whether a failed {@code eth_sendRawTransaction} shows that the node did not take the transaction. */
    private static boolean notTaken(IOException e) {
        if (e instanceof HttpStatusException status) {
            return status.status() < 500;
        }
        Throwable cause = e.getCause();
        return e instanceof JsonRpcException
                || cause instanceof ConnectException || cause instanceof HttpConnectTimeoutException;
    }

    /** Logs a reply that does not confirm the local hash; the node accepted the transaction either way. */
    private static void checkReportedHash(JsonNode accepted, String hash) {
        String reported;
        try {
            reported = Hex.encode(JsonRpcClient.decodeData(accepted, "eth_sendRawTransaction result"));
        } catch (IOException e) {
            LOGGER.log(System.Logger.Level.WARNING, "{0} for transaction {1}", e.getMessage(), hash);
            return;
        }
        if (!reported.equals(hash)) {
            LOGGER.log(System.Logger.Level.WARNING,
                    "eth_sendRawTransaction reported hash {0} for transaction {1}", reported, hash);
        }
    }

    private BigInteger estimateGas(Map<String, Object> call) throws IOException, InterruptedException {
        try {
            return JsonRpcClient.decodeQuantity(rpc.call("eth_estimateGas", List.of(call)), "eth_estimateGas");
        } catch (JsonRpcException e) {
            throw asRevert(e);
        }
    }

    private static BigInteger withMargin(BigInteger gas) {
        return gas.add(gas.multiply(BigInteger.valueOf(GAS_MARGIN_PERCENT)).divide(HUNDRED));
    }

    private BigInteger latestBaseFee() throws IOException, InterruptedException {
        JsonNode block = rpc.call("eth_getBlockByNumber", List.of("latest", false));
        if (!block.isObject()) {
            throw new IOException("eth_getBlockByNumber returned no latest block");
        }
        JsonNode baseFee = block.get("baseFeePerGas");
        if (baseFee == null || baseFee.isNull()) {
            throw new IOException("Latest block has no baseFeePerGas: the chain does not support EIP-1559");
        }
        return JsonRpcClient.decodeQuantity(baseFee, "baseFeePerGas");
    }

    private Map<String, Object> callObject(String to, byte[] data) {
        Objects.requireNonNull(data, "data");
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("from", rpcAddress);
        call.put("to", rpcAddress(to, "to"));
        call.put("data", Hex.encode(data));
        return call;
    }

    private static String rpcAddress(String address, String name) {
        Objects.requireNonNull(address, name);
        if (!EvmAddress.isValid(address)) {
            throw new IllegalArgumentException(name + " is not an EVM address");
        }
        return Hex.encode(EvmAddress.toBytes(address));
    }

    private static IOException asRevert(JsonRpcException e) {
        boolean reverted = e.code() == EXECUTION_REVERTED
                || e.rpcMessage().toLowerCase(Locale.ROOT).contains("revert");
        if (!reverted) {
            return e;
        }
        byte[] data = new byte[0];
        if (e.data() != null) {
            try {
                data = Hex.decode(e.data());
            } catch (IllegalArgumentException notHex) {
                // Some nodes put a text description in data; the message already carries it
                data = new byte[0];
            }
        }
        String message = e.rpcMessage();
        String reason = Abi.decodeRevertReason(data).orElse(null);
        if (reason != null && !message.contains(reason)) {
            message = message + ": " + reason;
        }
        ContractRevertException revert = new ContractRevertException(message, data);
        revert.initCause(e);
        return revert;
    }

    private static TransactionReceipt parseReceipt(JsonNode receipt, String hash) throws IOException {
        if (!receipt.isObject()) {
            throw new IOException("eth_getTransactionReceipt returned a non-object");
        }
        JsonNode reportedHash = receipt.get("transactionHash");
        if (reportedHash == null || !reportedHash.isTextual() || !hash.equalsIgnoreCase(reportedHash.textValue())) {
            throw new IOException("eth_getTransactionReceipt returned the receipt of another transaction");
        }
        BigInteger status = JsonRpcClient.decodeQuantity(receipt.get("status"), "receipt status");
        if (status.compareTo(BigInteger.ONE) > 0) {
            throw new IOException("Receipt status must be 0 or 1, got " + status);
        }
        BigInteger blockNumber = JsonRpcClient.decodeQuantity(receipt.get("blockNumber"), "receipt blockNumber");
        if (blockNumber.bitLength() >= Long.SIZE) {
            throw new IOException("Receipt blockNumber is out of range");
        }
        List<TransactionReceipt.Log> logs = parseLogs(receipt.get("logs"));
        return new TransactionReceipt(hash, blockNumber.longValue(), status.signum() == 1, logs);
    }

    private static List<TransactionReceipt.Log> parseLogs(JsonNode logs) throws IOException {
        if (logs == null || !logs.isArray()) {
            throw new IOException("Receipt has no logs array");
        }
        List<TransactionReceipt.Log> parsed = new ArrayList<>(logs.size());
        for (JsonNode log : logs) {
            JsonNode address = log.get("address");
            JsonNode topics = log.get("topics");
            JsonNode data = log.get("data");
            if (address == null || !address.isTextual() || topics == null || !topics.isArray()
                    || data == null || !data.isTextual()) {
                throw new IOException("Receipt log is missing address, topics or data");
            }
            List<String> topicList = new ArrayList<>(topics.size());
            for (JsonNode topic : topics) {
                if (!topic.isTextual()) {
                    throw new IOException("Receipt log topic is not a string");
                }
                topicList.add(topic.textValue());
            }
            try {
                parsed.add(new TransactionReceipt.Log(address.textValue(), topicList, data.textValue()));
            } catch (IllegalArgumentException e) {
                throw new IOException("Malformed receipt log: " + e.getMessage(), e);
            }
        }
        return parsed;
    }

    /**
     * Builder of {@link JsonRpcFacilitatorEvmSigner}. Not thread-safe; {@link #connect()} produces an immutable,
     * thread-safe signer.
     */
    public static final class Builder {

        private final String network;
        private final URI rpcUrl;
        private final PrivateKeyEvmSigner key;
        private final BigInteger expectedChainId;
        private HttpClient httpClient;
        private Duration requestTimeout = DEFAULT_REQUEST_TIMEOUT;
        private Duration receiptPollInterval = DEFAULT_RECEIPT_POLL_INTERVAL;
        private TimeSource time = TimeSource.SYSTEM;

        private Builder(String network, URI rpcUrl, PrivateKeyEvmSigner key) {
            this.network = Objects.requireNonNull(network, "network");
            this.rpcUrl = Objects.requireNonNull(rpcUrl, "rpcUrl");
            this.key = Objects.requireNonNull(key, "key");
            this.expectedChainId = EvmNetworks.chainId(network);
            String scheme = rpcUrl.getScheme();
            if (!rpcUrl.isAbsolute() || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
                throw new IllegalArgumentException("rpcUrl must be an absolute http or https URI");
            }
        }

        /**
         * Sets the HTTP client used for JSON-RPC requests. Defaults to a new client whose connect timeout is the
         * request timeout.
         *
         * @param httpClient the client
         * @return this builder
         */
        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = Objects.requireNonNull(httpClient, "httpClient");
            return this;
        }

        /**
         * Sets the timeout of each JSON-RPC request. Defaults to {@link #DEFAULT_REQUEST_TIMEOUT}.
         *
         * @param requestTimeout the timeout, positive
         * @return this builder
         * @throws IllegalArgumentException if {@code requestTimeout} is zero or negative
         */
        public Builder requestTimeout(Duration requestTimeout) {
            this.requestTimeout = requirePositive(requestTimeout, "requestTimeout");
            return this;
        }

        /**
         * Sets the delay between two receipt polls in {@link #waitForReceipt(String, Duration)}. Defaults to
         * {@link #DEFAULT_RECEIPT_POLL_INTERVAL}.
         *
         * @param receiptPollInterval the delay, positive
         * @return this builder
         * @throws IllegalArgumentException if {@code receiptPollInterval} is zero or negative
         */
        public Builder receiptPollInterval(Duration receiptPollInterval) {
            this.receiptPollInterval = requirePositive(receiptPollInterval, "receiptPollInterval");
            return this;
        }

        /**
         * Queries {@code eth_chainId} and creates the signer.
         *
         * @return the signer
         * @throws IllegalArgumentException if the endpoint serves another chain than the configured network
         * @throws IOException if the endpoint cannot be reached or answers with a malformed response
         * @throws InterruptedException if the calling thread is interrupted
         */
        public JsonRpcFacilitatorEvmSigner connect() throws IOException, InterruptedException {
            HttpClient client = httpClient != null
                    ? httpClient
                    : HttpClient.newBuilder().connectTimeout(requestTimeout).build();
            JsonRpcClient rpc = new JsonRpcClient(rpcUrl, client, requestTimeout);
            BigInteger actual = JsonRpcClient.decodeQuantity(rpc.call("eth_chainId", List.of()), "eth_chainId");
            if (!actual.equals(expectedChainId)) {
                throw new IllegalArgumentException(
                        "RPC endpoint serves chain " + actual + ", but the signer was configured for " + network);
            }
            return new JsonRpcFacilitatorEvmSigner(rpc, key, actual, receiptPollInterval, time);
        }

        /** Replaces the clock and sleep used for receipt polling and nonce tracking, for tests. */
        Builder timeSource(TimeSource time) {
            this.time = Objects.requireNonNull(time, "time");
            return this;
        }

        private static Duration requirePositive(Duration duration, String name) {
            Objects.requireNonNull(duration, name);
            if (duration.isNegative() || duration.isZero()) {
                throw new IllegalArgumentException(name + " must be positive");
            }
            return duration;
        }
    }

    /** Monotonic time and sleeping, replaceable in tests. */
    interface TimeSource {

        /** The system's monotonic clock and a thread sleep. */
        TimeSource SYSTEM = new TimeSource() {
            @Override
            public long nanoTime() {
                return System.nanoTime();
            }

            @Override
            public void sleep(long nanos) throws InterruptedException {
                TimeUnit.NANOSECONDS.sleep(nanos);
            }
        };

        /** Returns the current value of a monotonic clock, in nanoseconds. */
        long nanoTime();

        /** Sleeps for the given number of nanoseconds. */
        void sleep(long nanos) throws InterruptedException;
    }
}
