package org.x402.mechanisms.evm.exact;

import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Keccak;
import org.x402.mechanisms.evm.Secp256k1;
import org.x402.mechanisms.evm.Uint256;
import org.x402.mechanisms.evm.rpc.Abi;
import org.x402.mechanisms.evm.rpc.TransactionReceipt;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/**
 * The parts of an EIP-3009 token's onchain interface the facilitator uses: calldata for
 * {@code transferWithAuthorization} and the diagnostic reads, the mapping of revert messages to reason codes,
 * and the {@code Transfer} event check on a settlement receipt.
 *
 * <p>This class is stateless and thread-safe.
 */
final class Eip3009Token {

    /** The {@code v, r, s} overload, called for 65-byte EOA signatures. */
    static final String TRANSFER_WITH_AUTHORIZATION =
            "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";

    /** Whether an authorizer already used, or canceled, a nonce. */
    static final String AUTHORIZATION_STATE = "authorizationState(address,bytes32)";

    /** {@code keccak256("Transfer(address,address,uint256)")}, topic 0 of an ERC-20 {@code Transfer} event. */
    static final String TRANSFER_TOPIC = Hex.encode(
            Keccak.keccak256("Transfer(address,address,uint256)".getBytes(StandardCharsets.US_ASCII)));

    private static final int NONCE_LENGTH = 32;
    private static final int TRANSFER_TOPIC_COUNT = 3;

    private Eip3009Token() {
    }

    /**
     * Encodes {@code transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)}.
     *
     * @param authorization the signed authorization
     * @param signature the payer's signature over the authorization's EIP-712 digest
     * @return the calldata
     */
    static byte[] transferWithAuthorization(Eip3009Authorization authorization, Secp256k1.Signature signature) {
        return Abi.encodeCall(TRANSFER_WITH_AUTHORIZATION,
                authorization.from(),
                authorization.to(),
                Uint256.parse(authorization.value()),
                Uint256.parse(authorization.validAfter()),
                Uint256.parse(authorization.validBefore()),
                Hex.decode(authorization.nonce(), NONCE_LENGTH),
                signature.v(),
                Uint256.toBytes(signature.r()),
                Uint256.toBytes(signature.s()));
    }

    /**
     * Encodes {@code authorizationState(authorization.from, authorization.nonce)}, which returns {@code true} once
     * the nonce is used or canceled.
     *
     * @param authorization the authorization whose nonce to look up
     * @return the calldata
     */
    static byte[] authorizationState(Eip3009Authorization authorization) {
        return Abi.encodeCall(
                AUTHORIZATION_STATE, authorization.from(), Hex.decode(authorization.nonce(), NONCE_LENGTH));
    }

    /**
     * Encodes {@code balanceOf(account)}.
     *
     * @param account the token holder
     * @return the calldata
     */
    static byte[] balanceOf(String account) {
        return Abi.encodeCall("balanceOf(address)", account);
    }

    /**
     * Encodes {@code name()}, the token's EIP-712 domain name for FiatToken-style tokens.
     *
     * @return the calldata
     */
    static byte[] name() {
        return Abi.encodeCall("name()");
    }

    /**
     * Encodes {@code version()}, the token's EIP-712 domain version for FiatToken-style tokens.
     *
     * @return the calldata
     */
    static byte[] version() {
        return Abi.encodeCall("version()");
    }

    /**
     * Maps the message of a failed {@code transferWithAuthorization}, simulated or sent, to a reason code. The
     * substrings are FiatToken revert strings and the custom error names of other EIP-3009 implementations.
     * Matching is case-sensitive.
     *
     * @param message the failure message, e.g. {@code "execution reverted: FiatTokenV2: authorization is expired"};
     *     {@code null} is treated as empty
     * @return the specific reason, or {@link ExactEvmErrors#FAILED_TO_EXECUTE_TRANSFER} when nothing matches
     */
    static String reasonForTransferFailure(String message) {
        String text = message == null ? "" : message;
        if (containsAny(text, "authorization is expired", "AuthorizationExpired")) {
            return ExactEvmErrors.VALID_BEFORE_EXPIRED;
        }
        if (containsAny(text, "authorization is not yet valid", "AuthorizationNotYetValid")) {
            return ExactEvmErrors.VALID_AFTER_IN_FUTURE;
        }
        if (containsAny(text, "authorization is used", "AuthorizationAlreadyUsed", "AuthorizationUsedOrCanceled")) {
            return ExactEvmErrors.NONCE_ALREADY_USED;
        }
        if (containsAny(text, "transfer amount exceeds balance", "ERC20InsufficientBalance")) {
            return ExactEvmErrors.INSUFFICIENT_BALANCE;
        }
        if (containsAny(text, "invalid signature", "SignerMismatch", "InvalidSignatureV", "InvalidSignatureS")) {
            return ExactEvmErrors.INVALID_SIGNATURE;
        }
        return ExactEvmErrors.FAILED_TO_EXECUTE_TRANSFER;
    }

    /**
     * Returns whether a receipt carries the {@code Transfer(from, to, value)} event of an authorization, emitted by
     * the token. Logs of other contracts, other events and logs whose data is not a {@code uint256} are skipped.
     *
     * @param logs the receipt logs
     * @param token the token contract
     * @param authorization the settled authorization
     * @return {@code true} if a matching event is present
     */
    static boolean hasTransferEvent(
            List<TransactionReceipt.Log> logs, String token, Eip3009Authorization authorization) {
        byte[] from = EvmAddress.toBytes(authorization.from());
        byte[] to = EvmAddress.toBytes(authorization.to());
        BigInteger value = Uint256.parse(authorization.value());
        for (TransactionReceipt.Log log : logs) {
            List<String> topics = log.topics();
            if (!EvmAddress.equalsIgnoreCase(log.address(), token)
                    || topics.size() != TRANSFER_TOPIC_COUNT
                    || !TRANSFER_TOPIC.equalsIgnoreCase(Hex.encode(Hex.decode(topics.get(0))))) {
                continue;
            }
            byte[] data = Hex.decode(log.data());
            if (data.length < Abi.WORD_LENGTH) {
                continue;
            }
            if (Arrays.equals(topicAddress(topics.get(1)), from)
                    && Arrays.equals(topicAddress(topics.get(2)), to)
                    && Abi.decodeUint256(data).equals(value)) {
                return true;
            }
        }
        return false;
    }

    /** Returns the address in an indexed topic: its last 20 bytes. */
    private static byte[] topicAddress(String topic) {
        byte[] word = Hex.decode(topic);
        return Arrays.copyOfRange(word, word.length - EvmAddress.LENGTH, word.length);
    }

    private static boolean containsAny(String text, String... needles) {
        for (String needle : needles) {
            if (text.contains(needle)) {
                return true;
            }
        }
        return false;
    }
}
