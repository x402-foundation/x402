package org.x402.integration;

import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Keccak;
import org.x402.mechanisms.evm.Uint256;
import org.x402.mechanisms.evm.rpc.ContractRevertException;
import org.x402.mechanisms.evm.rpc.FacilitatorEvmSigner;
import org.x402.mechanisms.evm.rpc.TransactionReceipt;

import java.io.IOException;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * An in-memory chain holding one FiatToken-style EIP-3009 token, seen through the facilitator's account, so the
 * whole payment flow runs without a node.
 *
 * <p>The token has bytecode, balances ({@code balanceOf}) and EIP-3009 nonce state ({@code authorizationState}).
 * {@code transferWithAuthorization}, simulated with {@link #call} or sent with {@link #sendTransaction}, reverts with
 * FiatTokenV2's messages when the authorization is not yet valid, expired or already used, or the balance is short.
 * A sent transfer is mined at once: it consumes the nonce, moves the balance and gets a receipt with the
 * {@code Transfer} event. Signatures are not checked; the facilitator recovers them offline before calling the
 * chain. Thread-safe.
 */
final class SimulatedChain implements FacilitatorEvmSigner {

    /** A transaction the facilitator broadcast: its target, calldata and hash, all {@code 0x} hex. */
    record Broadcast(String to, String data, String hash) {
    }

    /**
     * The arguments of a {@code transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,
     * bytes32,bytes32)} call; {@code nonce}, {@code r} and {@code s} are 32-byte {@code 0x} hex.
     */
    record TransferWithAuthorization(String from, String to, BigInteger value, BigInteger validAfter,
            BigInteger validBefore, String nonce, int v, String r, String s) {

        /** Decodes calldata, failing unless it is exactly a call of the {@code v, r, s} overload. */
        static TransferWithAuthorization decode(byte[] calldata) {
            if (calldata.length != SELECTOR_LENGTH + 9 * WORD
                    || !TRANSFER_WITH_AUTHORIZATION.equals(selector(calldata))) {
                throw new IllegalArgumentException("not a transferWithAuthorization(..., v, r, s) call");
            }
            return new TransferWithAuthorization(address(calldata, 0), address(calldata, 1), uint(calldata, 2),
                    uint(calldata, 3), uint(calldata, 4), Hex.encode(word(calldata, 5)),
                    uint(calldata, 6).intValueExact(), Hex.encode(word(calldata, 7)), Hex.encode(word(calldata, 8)));
        }
    }

    // Selectors and event topic computed with `cast sig` and `cast keccak`
    private static final String TRANSFER_WITH_AUTHORIZATION = "0xe3ee160e";
    private static final String AUTHORIZATION_STATE = "0xe94a0102";
    private static final String BALANCE_OF = "0x70a08231";
    private static final String TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    private static final byte[] TOKEN_CODE = Hex.decode("0x6080604052");
    private static final int SELECTOR_LENGTH = 4;
    private static final int WORD = 32;

    private final BigInteger chainId;
    private final String facilitator;
    private final String token;
    private final Clock clock = Clock.systemUTC();
    private final Map<String, BigInteger> balances = new HashMap<>();
    private final Set<String> usedAuthorizations = new HashSet<>();
    private final Map<String, TransactionReceipt> receipts = new HashMap<>();
    private final List<Broadcast> broadcasts = new ArrayList<>();
    private boolean revertNextTransaction;

    SimulatedChain(BigInteger chainId, String facilitator, String token) {
        this.chainId = chainId;
        this.facilitator = facilitator;
        this.token = token;
    }

    synchronized SimulatedChain fund(String account, BigInteger amount) {
        balances.merge(key(account), amount, BigInteger::add);
        return this;
    }

    synchronized List<Broadcast> broadcasts() {
        return List.copyOf(broadcasts);
    }

    /** Makes the next transaction pass gas estimation but revert when mined, leaving the token unchanged. */
    synchronized void revertNextTransaction() {
        revertNextTransaction = true;
    }

    @Override
    public List<String> addresses() {
        return List.of(facilitator);
    }

    @Override
    public BigInteger chainId() {
        return chainId;
    }

    @Override
    public synchronized byte[] call(String to, byte[] data) throws IOException {
        if (!isToken(to)) {
            return new byte[0];
        }
        switch (selector(data)) {
            case TRANSFER_WITH_AUTHORIZATION:
                transfer(TransferWithAuthorization.decode(data), false);
                return new byte[0];
            case AUTHORIZATION_STATE:
                boolean used = usedAuthorizations.contains(authorizationKey(address(data, 0), word(data, 1)));
                return Uint256.toBytes(used ? BigInteger.ONE : BigInteger.ZERO);
            case BALANCE_OF:
                return Uint256.toBytes(balance(address(data, 0)));
            default:
                throw new ContractRevertException("execution reverted", new byte[0]);
        }
    }

    @Override
    public synchronized byte[] getCode(String address) {
        return isToken(address) ? TOKEN_CODE.clone() : new byte[0];
    }

    @Override
    public synchronized String sendTransaction(String to, byte[] data) throws IOException {
        if (!isToken(to)) {
            throw new IOException("the simulated chain only executes calls to " + token);
        }
        TransferWithAuthorization call = TransferWithAuthorization.decode(data);
        String hash = Hex.encode(Keccak.keccak256(data));
        long block = receipts.size() + 1L;
        TransactionReceipt receipt;
        if (revertNextTransaction) {
            revertNextTransaction = false;
            receipt = new TransactionReceipt(hash, block, false, List.of());
        } else {
            // Like eth_estimateGas, a transfer that would revert fails before anything is broadcast
            transfer(call, true);
            TransactionReceipt.Log event = new TransactionReceipt.Log(token,
                    List.of(TRANSFER_TOPIC, Hex.encode(word(data, 0)), Hex.encode(word(data, 1))),
                    Hex.encode(Uint256.toBytes(call.value())));
            receipt = new TransactionReceipt(hash, block, true, List.of(event));
        }
        broadcasts.add(new Broadcast(to, Hex.encode(data), hash));
        receipts.put(hash, receipt);
        return hash;
    }

    @Override
    public synchronized TransactionReceipt waitForReceipt(String transactionHash, Duration timeout)
            throws IOException {
        TransactionReceipt receipt = receipts.get(transactionHash);
        if (receipt == null) {
            throw new IOException("No receipt for " + transactionHash);
        }
        return receipt;
    }

    /** Applies FiatTokenV2's checks in its order and, if {@code execute}, the transfer. */
    private void transfer(TransferWithAuthorization call, boolean execute) throws ContractRevertException {
        BigInteger now = BigInteger.valueOf(clock.instant().getEpochSecond());
        if (now.compareTo(call.validAfter()) <= 0) {
            throw revert("FiatTokenV2: authorization is not yet valid");
        }
        if (now.compareTo(call.validBefore()) >= 0) {
            throw revert("FiatTokenV2: authorization is expired");
        }
        String authorization = authorizationKey(call.from(), Hex.decode(call.nonce()));
        if (usedAuthorizations.contains(authorization)) {
            throw revert("FiatTokenV2: authorization is used or canceled");
        }
        if (balance(call.from()).compareTo(call.value()) < 0) {
            throw revert("ERC20: transfer amount exceeds balance");
        }
        if (execute) {
            usedAuthorizations.add(authorization);
            balances.put(key(call.from()), balance(call.from()).subtract(call.value()));
            balances.merge(key(call.to()), call.value(), BigInteger::add);
        }
    }

    private BigInteger balance(String account) {
        return balances.getOrDefault(key(account), BigInteger.ZERO);
    }

    private boolean isToken(String address) {
        return EvmAddress.equalsIgnoreCase(address, token);
    }

    private static String authorizationKey(String authorizer, byte[] nonce) {
        return key(authorizer) + Hex.encodeNoPrefix(nonce);
    }

    private static ContractRevertException revert(String reason) {
        return new ContractRevertException("execution reverted: " + reason, new byte[0]);
    }

    private static String selector(byte[] data) {
        return Hex.encode(Arrays.copyOf(data, SELECTOR_LENGTH));
    }

    private static byte[] word(byte[] data, int index) {
        int from = SELECTOR_LENGTH + WORD * index;
        return Arrays.copyOfRange(data, from, from + WORD);
    }

    private static BigInteger uint(byte[] data, int index) {
        return new BigInteger(1, word(data, index));
    }

    private static String address(byte[] data, int index) {
        return EvmAddress.toChecksum(Arrays.copyOfRange(word(data, index), WORD - EvmAddress.LENGTH, WORD));
    }

    private static String key(String address) {
        return address.toLowerCase(Locale.ROOT);
    }
}
