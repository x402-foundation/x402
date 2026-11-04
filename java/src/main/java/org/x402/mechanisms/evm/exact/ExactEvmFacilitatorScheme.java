package org.x402.mechanisms.evm.exact;

import org.x402.InMemoryPendingSettlementStore;
import org.x402.PendingSettlementStore;
import org.x402.SchemeNetworkFacilitator;
import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.EvmConstants;
import org.x402.mechanisms.evm.EvmNetworks;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Secp256k1;
import org.x402.mechanisms.evm.TypedDataDomain;
import org.x402.mechanisms.evm.Uint256;
import org.x402.mechanisms.evm.rpc.Abi;
import org.x402.mechanisms.evm.rpc.BroadcastOutcomeUnknownException;
import org.x402.mechanisms.evm.rpc.ContractRevertException;
import org.x402.mechanisms.evm.rpc.FacilitatorEvmSigner;
import org.x402.mechanisms.evm.rpc.TransactionReceipt;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.types.VerifyResponse;

import java.io.IOException;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;

/**
 * Facilitator side of the exact scheme on EVM networks for EIP-3009 {@code TransferWithAuthorization} payments.
 * {@code verify} checks the payload against the requirements, the validity window and the EIP-712 signature, then
 * simulates the transfer with {@code eth_call}. {@code settle} verifies again, sends {@code transferWithAuthorization}
 * from the signer's account and waits for the receipt. Invalid payments and failed settlements are returned as
 * {@code isValid=false} or {@code success=false} with an {@link ExactEvmErrors} reason.
 *
 * <pre>{@code
 * FacilitatorEvmSigner signer = JsonRpcFacilitatorEvmSigner
 *         .builder("eip155:84532", URI.create(rpcUrl), PrivateKeyEvmSigner.fromHex(facilitatorKey))
 *         .connect();
 * SchemeNetworkFacilitator exact = new ExactEvmFacilitatorScheme(signer);
 * // register exact for "eip155:84532" on the facilitator
 * }</pre>
 *
 * <p>Only ECDSA signatures of externally owned accounts are supported. A payer with bytecode (ERC-1271, EIP-7702)
 * gives {@code FAILED_TO_VERIFY_SIGNATURE}, and an ERC-6492 signature gives {@code FACTORY_NOT_ALLOWED}.
 *
 * <p>When the receipt does not arrive within the receipt timeout, or the node's answer to the broadcast is lost,
 * settle returns {@code settlement_pending} with the transaction hash and records it in the
 * {@link PendingSettlementStore}. Settling the same payload again waits for that transaction instead of
 * broadcasting the authorization a second time.
 *
 * <p>Instances are thread-safe if the signer and the pending-settlement store are.
 */
public final class ExactEvmFacilitatorScheme implements SchemeNetworkFacilitator {

    /**
     * Default time {@code settle} waits for the receipt before reporting {@code settlement_pending}: 60 seconds,
     * below {@link org.x402.http.HttpFacilitatorClient#DEFAULT_TIMEOUT}, so a remote resource server receives the
     * pending result and its hash instead of timing out.
     */
    public static final Duration DEFAULT_RECEIPT_TIMEOUT = Duration.ofSeconds(60);

    /** Seconds {@code validBefore} must lie beyond now, leaving time to settle. */
    private static final long VALID_BEFORE_BUFFER_SECONDS = 6;

    /** Upper bound of node-supplied text copied into a response. */
    private static final int MAX_MESSAGE_LENGTH = 500;

    /** Suffix of ERC-6492 wrapped signatures. */
    private static final byte[] ERC6492_MAGIC =
            Hex.decode("0x6492649264926492649264926492649264926492649264926492649264926492");

    private static final System.Logger LOGGER = System.getLogger(ExactEvmFacilitatorScheme.class.getName());

    private final FacilitatorEvmSigner signer;
    private final Clock clock;
    private final boolean simulateInSettle;
    private final Duration receiptTimeout;
    private final PendingSettlementStore pendingSettlements;

    /**
     * Creates a scheme with the default settings: system clock, no simulation in settle, a
     * {@link #DEFAULT_RECEIPT_TIMEOUT} and a new {@link InMemoryPendingSettlementStore}.
     *
     * @param signer the facilitator's account on the chain it settles on
     */
    public ExactEvmFacilitatorScheme(FacilitatorEvmSigner signer) {
        this(builder(signer));
    }

    private ExactEvmFacilitatorScheme(Builder builder) {
        this.signer = builder.signer;
        this.clock = builder.clock;
        this.simulateInSettle = builder.simulateInSettle;
        this.receiptTimeout = builder.receiptTimeout;
        this.pendingSettlements = builder.pendingSettlements != null
                ? builder.pendingSettlements
                : new InMemoryPendingSettlementStore();
    }

    /**
     * Starts building a scheme with non-default settings.
     *
     * @param signer the facilitator's account on the chain it settles on
     * @return a builder
     */
    public static Builder builder(FacilitatorEvmSigner signer) {
        return new Builder(signer);
    }

    @Override
    public String scheme() {
        return EvmConstants.SCHEME_EXACT;
    }

    @Override
    public String caipFamily() {
        return EvmNetworks.FAMILY;
    }

    /**
     * Returns {@code null}: the exact EVM scheme advertises no extra data in {@code /supported}.
     *
     * @param network the CAIP-2 network
     * @return {@code null}
     */
    @Override
    public Map<String, Object> extra(String network) {
        return null;
    }

    /**
     * Returns the signer's addresses, whatever the network.
     *
     * @param network the CAIP-2 network
     * @return the facilitator addresses
     */
    @Override
    public List<String> signers(String network) {
        return List.copyOf(signer.addresses());
    }

    /**
     * Verifies a payment, including a simulation of the transfer.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the result; {@code payer} is {@code authorization.from} once the payload could be parsed
     * @throws IOException if the asset's bytecode cannot be read
     * @throws InterruptedException if the calling thread is interrupted
     */
    @Override
    public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(requirements, "requirements");
        return check(payload, requirements, true).response();
    }

    /**
     * Verifies and settles a payment onchain, or, if this payload's transaction is pending, waits for it.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the result; on failure {@code transaction} is empty unless a transaction may have been broadcast
     * @throws InterruptedException if the calling thread is interrupted before the transaction is broadcast; an
     *     interrupt during the broadcast or while waiting for the receipt is reported as {@code settlement_pending}
     *     with the interrupt flag restored
     */
    @Override
    public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements)
            throws InterruptedException {
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(requirements, "requirements");
        String network = payload.accepted() != null ? payload.accepted().network() : requirements.network();

        ExactEvmPayload parsed = parse(payload);
        if (parsed != null && parsed.hasSignature()) {
            Optional<String> pending = pendingTransaction(parsed.signature());
            if (pending.isPresent()) {
                // Removed first so a concurrent retry takes the normal path and fails on the used nonce
                forgetPending(parsed.signature());
                Eip3009Authorization authorization = parsed.authorization();
                return awaitSettlement(new Settlement(parsed.signature(), requirements.asset(), authorization,
                        authorization.from(), network), pending.get());
            }
        }

        Verification verification;
        try {
            verification = check(payload, requirements, simulateInSettle);
        } catch (IOException e) {
            return SettleResponse.failure(
                    ExactEvmErrors.VERIFICATION_FAILED, truncate(e.getMessage()), null, "", network);
        }
        VerifyResponse verified = verification.response();
        if (!verified.isValid()) {
            return SettleResponse.failure(
                    verified.invalidReason(), verified.invalidMessage(), verified.payer(), "", network);
        }
        String payer = verified.payer();
        Eip3009Authorization authorization = verification.authorization();
        Settlement settlement =
                new Settlement(parsed.signature(), verification.asset(), authorization, payer, network);

        String transaction;
        try {
            transaction = signer.sendTransaction(
                    verification.asset(),
                    Eip3009Token.transferWithAuthorization(authorization, verification.signature()));
        } catch (BroadcastOutcomeUnknownException e) {
            return pending(settlement, e.transactionHash(), truncate(e.getMessage()));
        } catch (IOException e) {
            return SettleResponse.failure(Eip3009Token.reasonForTransferFailure(e.getMessage()),
                    truncate(e.getMessage()), payer, "", network);
        }
        return awaitSettlement(settlement, transaction);
    }

    /**
     * Waits for a broadcast transaction: a missing receipt leaves the settlement pending, any receipt is final.
     */
    private SettleResponse awaitSettlement(Settlement settlement, String transaction) {
        String payer = settlement.payer();
        String network = settlement.network();
        if (!isValidTransactionHash(transaction)) {
            forgetPending(settlement.key());
            return SettleResponse.failure(ExactEvmErrors.TRANSACTION_FAILED,
                    "signer returned an invalid transaction hash", payer, "", network);
        }
        TransactionReceipt receipt;
        try {
            receipt = signer.waitForReceipt(transaction, receiptTimeout);
        } catch (IOException e) {
            return pending(settlement, transaction, truncate(e.getMessage()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return pending(settlement, transaction, "interrupted while waiting for the receipt");
        }
        forgetPending(settlement.key());
        if (!receipt.successful()) {
            return SettleResponse.failure(ExactEvmErrors.TRANSACTION_FAILED, null, payer, transaction, network);
        }
        if (receipt.logs() != null && !Eip3009Token.hasTransferEvent(
                receipt.logs(), settlement.asset(), settlement.authorization())) {
            return SettleResponse.failure(ExactEvmErrors.TRANSFER_EVENT_MISMATCH, null, payer, transaction, network);
        }
        return SettleResponse.success(payer, transaction, network);
    }

    /** Records a broadcast transaction without a receipt so that settling the payload again reconciles it. */
    private SettleResponse pending(Settlement settlement, String transaction, String message) {
        try {
            pendingSettlements.put(settlement.key(), transaction);
        } catch (IOException e) {
            // A retry would not find the transaction and could broadcast the authorization again, so this is final
            return SettleResponse.failure(ExactEvmErrors.TRANSACTION_FAILED,
                    truncate("settlement_pending, but failed to persist for retry: " + e.getMessage()),
                    settlement.payer(), transaction, settlement.network());
        }
        return SettleResponse.failure(ExactEvmErrors.SETTLEMENT_PENDING, message, settlement.payer(), transaction,
                settlement.network());
    }

    /** Looks up a pending transaction; a store failure counts as none. */
    private Optional<String> pendingTransaction(String key) {
        try {
            return pendingSettlements.get(key);
        } catch (IOException e) {
            LOGGER.log(System.Logger.Level.WARNING,
                    "Pending settlement lookup failed, settling normally: {0}", e.getMessage());
            return Optional.empty();
        }
    }

    /** Drops a pending entry; a failure only leaves an entry that expires on its own. */
    private void forgetPending(String key) {
        try {
            pendingSettlements.remove(key);
        } catch (IOException e) {
            LOGGER.log(System.Logger.Level.WARNING, "Pending settlement removal failed: {0}", e.getMessage());
        }
    }

    private static ExactEvmPayload parse(PaymentPayload payload) {
        try {
            return ExactEvmPayload.fromMap(Objects.requireNonNullElse(payload.payload(), Map.of()));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Runs the checks that need no chain access, then the onchain ones. */
    private Verification check(PaymentPayload payload, PaymentRequirements requirements, boolean simulate)
            throws IOException, InterruptedException {
        PaymentRequirements accepted = payload.accepted();
        String acceptedScheme = accepted == null ? null : accepted.scheme();
        if (!EvmConstants.SCHEME_EXACT.equals(acceptedScheme)) {
            return Verification.rejected(ExactEvmErrors.INVALID_SCHEME, "invalid scheme: " + acceptedScheme, null);
        }
        if (!Objects.equals(accepted.network(), requirements.network())) {
            return Verification.rejected(ExactEvmErrors.NETWORK_MISMATCH,
                    "network mismatch: " + accepted.network() + " != " + requirements.network(), null);
        }

        ExactEvmPayload evmPayload;
        try {
            evmPayload = ExactEvmPayload.fromMap(Objects.requireNonNullElse(payload.payload(), Map.of()));
        } catch (IllegalArgumentException e) {
            return Verification.rejected(
                    ExactEvmErrors.INVALID_PAYLOAD, "failed to parse EVM payload: " + e.getMessage(), null);
        }
        if (!evmPayload.hasSignature()) {
            return Verification.rejected(ExactEvmErrors.MISSING_SIGNATURE, "missing signature", null);
        }

        BigInteger chainId;
        try {
            chainId = EvmNetworks.chainId(Objects.requireNonNullElse(requirements.network(), ""));
        } catch (IllegalArgumentException e) {
            return Verification.rejected(ExactEvmErrors.FAILED_TO_GET_NETWORK_CONFIG, e.getMessage(), null);
        }
        if (!chainId.equals(signer.chainId())) {
            return Verification.rejected(ExactEvmErrors.FAILED_TO_GET_NETWORK_CONFIG,
                    "facilitator signer is connected to chain " + signer.chainId() + ", not "
                            + requirements.network(), null);
        }

        Eip3009Authorization authorization = evmPayload.authorization();
        if (!EvmAddress.equalsIgnoreCase(authorization.to(), requirements.payTo())) {
            return Verification.rejected(ExactEvmErrors.RECIPIENT_MISMATCH,
                    "recipient mismatch: " + authorization.to() + " != " + requirements.payTo(), null);
        }

        String payer = authorization.from();
        BigInteger required;
        try {
            required = Uint256.parse(Objects.requireNonNullElse(requirements.amount(), ""));
        } catch (IllegalArgumentException e) {
            return Verification.rejected(ExactEvmErrors.INVALID_REQUIRED_AMOUNT,
                    "invalid required amount: " + requirements.amount(), null);
        }
        BigInteger value = Uint256.parse(authorization.value());
        if (!value.equals(required)) {
            return Verification.rejected(ExactEvmErrors.AUTHORIZATION_VALUE_MISMATCH,
                    "authorization value mismatch: " + value + " != " + required, payer);
        }

        BigInteger now = BigInteger.valueOf(clock.instant().getEpochSecond());
        BigInteger validBefore = Uint256.parse(authorization.validBefore());
        if (validBefore.compareTo(now.add(BigInteger.valueOf(VALID_BEFORE_BUFFER_SECONDS))) < 0) {
            return Verification.rejected(
                    ExactEvmErrors.VALID_BEFORE_EXPIRED, "valid before expired: " + validBefore, payer);
        }
        BigInteger validAfter = Uint256.parse(authorization.validAfter());
        if (validAfter.compareTo(now) > 0) {
            return Verification.rejected(
                    ExactEvmErrors.VALID_AFTER_IN_FUTURE, "valid after in future: " + validAfter, payer);
        }

        String name = nonEmptyString(requirements.extra(), "name");
        String version = nonEmptyString(requirements.extra(), "version");
        if (name == null || version == null) {
            return Verification.rejected(ExactEvmErrors.MISSING_EIP712_DOMAIN,
                    "missing EIP-712 domain name/version in requirements.extra", payer);
        }

        byte[] signature;
        try {
            signature = Hex.decode(evmPayload.signature());
        } catch (IllegalArgumentException e) {
            return Verification.rejected(ExactEvmErrors.INVALID_SIGNATURE_FORMAT, e.getMessage(), payer);
        }

        String asset = requirements.asset();
        if (!EvmAddress.isValid(asset)) {
            return Verification.rejected(ExactEvmErrors.ASSET_NOT_DEPLOYED_CONTRACT,
                    "asset " + asset + " is not an EVM address", payer);
        }
        Payment payment = new Payment(authorization, signature, required,
                new TypedDataDomain(name, version, chainId, asset));
        return checkOnchain(payment, simulate);
    }

    /** Checks the signature, the asset and, if requested, simulates the transfer. */
    private Verification checkOnchain(Payment payment, boolean simulate) throws IOException, InterruptedException {
        String payer = payment.authorization().from();
        byte[] payerCode;
        try {
            payerCode = signer.getCode(payer);
        } catch (IOException e) {
            return Verification.rejected(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE, truncate(e.getMessage()), payer);
        }
        byte[] signatureBytes = payment.signature();
        boolean payerDeployed = payerCode.length > 0;
        if (signatureBytes.length == Secp256k1.SIGNATURE_LENGTH && !payerDeployed
                && !Secp256k1.isCanonical(signatureBytes)) {
            return Verification.rejected(ExactEvmErrors.INVALID_SIGNATURE_S, "invalid signature s", payer);
        }
        if (payerDeployed) {
            return Verification.rejected(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE,
                    "payer has bytecode: smart-contract wallet (ERC-1271) signatures are not supported", payer);
        }
        if (isErc6492(signatureBytes)) {
            return Verification.rejected(ExactEvmErrors.FACTORY_NOT_ALLOWED,
                    "counterfactual wallet (ERC-6492) signatures are not supported", payer);
        }

        Secp256k1.Signature signature;
        String recovered;
        try {
            signature = Secp256k1.Signature.fromBytes(signatureBytes);
            recovered = Secp256k1.recoverAddress(payment.authorization().digest(payment.domain()), signature);
        } catch (IllegalArgumentException e) {
            return Verification.rejected(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE, e.getMessage(), payer);
        }
        if (!EvmAddress.equalsIgnoreCase(recovered, payer)) {
            return Verification.rejected(
                    ExactEvmErrors.INVALID_SIGNATURE, "invalid signature: recovered signer " + recovered, payer);
        }

        String asset = payment.domain().verifyingContract();
        if (signer.getCode(asset).length == 0) {
            return Verification.rejected(ExactEvmErrors.ASSET_NOT_DEPLOYED_CONTRACT,
                    "asset " + asset + " is not a deployed contract", payer);
        }

        if (simulate) {
            SimulationFailure failure = simulate(payment, signature);
            if (failure != null) {
                return Verification.rejected(failure.reason(), failure.message(), payer);
            }
        }
        return new Verification(VerifyResponse.valid(payer), payment.authorization(), signature, asset);
    }

    /**
     * Simulates {@code transferWithAuthorization} with {@code eth_call}.
     *
     * @return {@code null} when the call succeeds, otherwise the reason and the node's message
     */
    private SimulationFailure simulate(Payment payment, Secp256k1.Signature signature) throws InterruptedException {
        String asset = payment.domain().verifyingContract();
        try {
            signer.call(asset, Eip3009Token.transferWithAuthorization(payment.authorization(), signature));
            return null;
        } catch (ContractRevertException e) {
            String reason = Eip3009Token.reasonForTransferFailure(e.getMessage());
            if (reason.equals(ExactEvmErrors.FAILED_TO_EXECUTE_TRANSFER)) {
                reason = diagnose(payment);
            }
            return new SimulationFailure(reason, truncate(e.getMessage()));
        } catch (IOException e) {
            // The node did not answer, so nothing is known about the payment; probing would fail the same way
            return new SimulationFailure(ExactEvmErrors.EIP3009_SIMULATION_FAILED, truncate(e.getMessage()));
        }
    }

    /**
     * Explains a revert the message did not identify by reading the token's state. Reads stop at the first
     * conclusive answer.
     */
    private String diagnose(Payment payment) throws InterruptedException {
        Eip3009Authorization authorization = payment.authorization();
        TypedDataDomain domain = payment.domain();
        String asset = domain.verifyingContract();
        try {
            Optional<Boolean> used = read(asset, Eip3009Token.authorizationState(authorization), Abi::decodeBool);
            if (used.isEmpty()) {
                return ExactEvmErrors.EIP3009_NOT_SUPPORTED;
            }
            if (used.get()) {
                return ExactEvmErrors.NONCE_ALREADY_USED;
            }
            Optional<String> name = read(asset, Eip3009Token.name(), Abi::decodeString);
            if (name.isPresent() && !name.get().equals(domain.name())) {
                return ExactEvmErrors.EIP3009_TOKEN_NAME_MISMATCH;
            }
            Optional<String> version = read(asset, Eip3009Token.version(), Abi::decodeString);
            if (version.isPresent() && !version.get().equals(domain.version())) {
                return ExactEvmErrors.EIP3009_TOKEN_VERSION_MISMATCH;
            }
            Optional<BigInteger> balance =
                    read(asset, Eip3009Token.balanceOf(authorization.from()), Abi::decodeUint256);
            if (balance.isPresent() && balance.get().compareTo(payment.required()) < 0) {
                return ExactEvmErrors.INSUFFICIENT_BALANCE;
            }
        } catch (IOException e) {
            // An unreachable node leaves the revert unexplained
            return ExactEvmErrors.EIP3009_SIMULATION_FAILED;
        }
        return ExactEvmErrors.EIP3009_SIMULATION_FAILED;
    }

    /**
     * Calls a view function, treating a revert or undecodable result as no answer.
     *
     * @throws IOException if the node cannot be reached
     */
    private <T> Optional<T> read(String contract, byte[] calldata, Function<byte[], T> decoder)
            throws IOException, InterruptedException {
        byte[] result;
        try {
            result = signer.call(contract, calldata);
        } catch (ContractRevertException e) {
            return Optional.empty();
        }
        try {
            return Optional.of(decoder.apply(result));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    private static boolean isErc6492(byte[] signature) {
        return signature.length >= ERC6492_MAGIC.length && Arrays.equals(
                signature, signature.length - ERC6492_MAGIC.length, signature.length,
                ERC6492_MAGIC, 0, ERC6492_MAGIC.length);
    }

    /** Returns whether a hash is {@code 0x} and 64 hex digits, not all zero. */
    private static boolean isValidTransactionHash(String hash) {
        if (hash == null || hash.length() != 66 || !hash.startsWith("0x")) {
            return false;
        }
        try {
            byte[] bytes = Hex.decode(hash);
            for (byte b : bytes) {
                if (b != 0) {
                    return true;
                }
            }
            return false;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static String nonEmptyString(Map<String, Object> extra, String key) {
        Object value = extra == null ? null : extra.get(key);
        return value instanceof String text && !text.isEmpty() ? text : null;
    }

    private static String truncate(String message) {
        if (message == null || message.codePointCount(0, message.length()) <= MAX_MESSAGE_LENGTH) {
            return message;
        }
        return message.substring(0, message.offsetByCodePoints(0, MAX_MESSAGE_LENGTH));
    }

    /**
     * Builder of {@link ExactEvmFacilitatorScheme}. Not thread-safe; the built scheme's settings never change.
     *
     * <pre>{@code
     * ExactEvmFacilitatorScheme exact = ExactEvmFacilitatorScheme.builder(signer)
     *         .simulateInSettle(true)                 // re-run the eth_call simulation before sending
     *         .receiptTimeout(Duration.ofSeconds(30)) // then report settlement_pending
     *         .pendingSettlementStore(sharedStore)    // shared by every facilitator replica
     *         .build();
     * }</pre>
     */
    public static final class Builder {

        private final FacilitatorEvmSigner signer;
        private Clock clock = Clock.systemUTC();
        private boolean simulateInSettle;
        private Duration receiptTimeout = DEFAULT_RECEIPT_TIMEOUT;
        private PendingSettlementStore pendingSettlements;

        private Builder(FacilitatorEvmSigner signer) {
            this.signer = Objects.requireNonNull(signer, "signer");
        }

        /**
         * Sets the clock the authorization's validity window is checked against. Defaults to the system UTC clock;
         * replace it in tests.
         *
         * @param clock the clock
         * @return this builder
         */
        public Builder clock(Clock clock) {
            this.clock = Objects.requireNonNull(clock, "clock");
            return this;
        }

        /**
         * Sets whether {@code settle} simulates the transfer again before sending it. Defaults to {@code false}:
         * {@code verify} always simulates, and the transaction's gas estimation catches a transfer that would
         * revert.
         *
         * @param simulateInSettle {@code true} to simulate in settle too
         * @return this builder
         */
        public Builder simulateInSettle(boolean simulateInSettle) {
            this.simulateInSettle = simulateInSettle;
            return this;
        }

        /**
         * Sets how long {@code settle} waits for the receipt of the broadcast transaction before reporting
         * {@code settlement_pending}. Defaults to {@link #DEFAULT_RECEIPT_TIMEOUT}. Keep the whole settlement,
         * this wait included, below the resource server's timeout for the facilitator's answer.
         *
         * @param receiptTimeout the timeout, positive
         * @return this builder
         * @throws IllegalArgumentException if {@code receiptTimeout} is zero or negative
         */
        public Builder receiptTimeout(Duration receiptTimeout) {
            Objects.requireNonNull(receiptTimeout, "receiptTimeout");
            if (receiptTimeout.isNegative() || receiptTimeout.isZero()) {
                throw new IllegalArgumentException("receiptTimeout must be positive");
            }
            this.receiptTimeout = receiptTimeout;
            return this;
        }

        /**
         * Sets where transactions awaiting a receipt are remembered. Defaults to a new
         * {@link InMemoryPendingSettlementStore} per scheme; a facilitator with several replicas needs a store they
         * share, since the retry may reach another replica.
         *
         * @param store the store
         * @return this builder
         */
        public Builder pendingSettlementStore(PendingSettlementStore store) {
            this.pendingSettlements = Objects.requireNonNull(store, "store");
            return this;
        }

        /**
         * Creates the scheme.
         *
         * @return the scheme
         */
        public ExactEvmFacilitatorScheme build() {
            return new ExactEvmFacilitatorScheme(this);
        }
    }

    /**
     * A payment being settled: its pending-store key (the signature), the token, the authorization the receipt
     * must show, the payer and the network reported back.
     */
    private record Settlement(
            String key, String asset, Eip3009Authorization authorization, String payer, String network) {
    }

    /** Why a transfer simulation failed: a reason code and the node's message. */
    private record SimulationFailure(String reason, String message) {
    }

    /** A payment that passed every check that needs no chain access. */
    private record Payment(
            Eip3009Authorization authorization, byte[] signature, BigInteger required, TypedDataDomain domain) {
    }

    /**
     * The outcome of a check: the response, plus the parsed authorization, signature and asset settle needs when
     * the payment is valid.
     */
    private record Verification(
            VerifyResponse response, Eip3009Authorization authorization, Secp256k1.Signature signature, String asset) {

        static Verification rejected(String reason, String message, String payer) {
            return new Verification(VerifyResponse.invalid(reason, message, payer), null, null, null);
        }
    }
}
