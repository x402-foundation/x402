package org.x402.mechanisms.evm.exact;

import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Secp256k1;
import org.x402.mechanisms.evm.rpc.TransactionReceipt;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_SIGNATURE;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.CastVectors.NONCE;
import static org.x402.mechanisms.evm.CastVectors.VALID_BEFORE;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.AUTHORIZATION_STATE_CALLDATA;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.BALANCE_OF_CALLDATA;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TRANSFER_TOPIC;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TWA_CALLDATA;

class Eip3009TokenTest {

    private static final Eip3009Authorization AUTHORIZATION =
            new Eip3009Authorization(ANVIL_ADDRESS_0, ANVIL_ADDRESS_1, "1000", "0", VALID_BEFORE, NONCE);
    private static final String FROM_TOPIC = "0x" + "00".repeat(12) + ANVIL_ADDRESS_0.substring(2);
    private static final String TO_TOPIC = "0x" + "00".repeat(12) + ANVIL_ADDRESS_1.substring(2);
    private static final String VALUE_1000 = "0x" + "00".repeat(30) + "03e8";

    @Test
    void encodesTransferWithAuthorizationLikeCastCalldata() {
        Secp256k1.Signature signature = Secp256k1.Signature.fromBytes(Hex.decode(BASE_SEPOLIA_SIGNATURE));

        assertEquals(TWA_CALLDATA, Hex.encode(Eip3009Token.transferWithAuthorization(AUTHORIZATION, signature)));
    }

    @Test
    void encodesDiagnosticReadsLikeCastCalldata() {
        assertEquals(AUTHORIZATION_STATE_CALLDATA, Hex.encode(Eip3009Token.authorizationState(AUTHORIZATION)));
        assertEquals(BALANCE_OF_CALLDATA, Hex.encode(Eip3009Token.balanceOf(ANVIL_ADDRESS_0)));
        assertEquals("0x06fdde03", Hex.encode(Eip3009Token.name()));
        assertEquals("0x54fd4d50", Hex.encode(Eip3009Token.version()));
    }

    @Test
    void transferTopicIsTheKeccakOfTheEventSignature() {
        assertEquals(TRANSFER_TOPIC, Eip3009Token.TRANSFER_TOPIC);
    }

    @Test
    void mapsFiatTokenRevertStrings() {
        assertEquals(ExactEvmErrors.VALID_BEFORE_EXPIRED,
                reason("execution reverted: FiatTokenV2: authorization is expired"));
        assertEquals(ExactEvmErrors.VALID_AFTER_IN_FUTURE,
                reason("execution reverted: FiatTokenV2: authorization is not yet valid"));
        assertEquals(ExactEvmErrors.NONCE_ALREADY_USED,
                reason("execution reverted: FiatTokenV2: authorization is used or canceled"));
        assertEquals(ExactEvmErrors.INSUFFICIENT_BALANCE,
                reason("execution reverted: ERC20: transfer amount exceeds balance"));
        assertEquals(ExactEvmErrors.INVALID_SIGNATURE, reason("execution reverted: FiatTokenV2: invalid signature"));
    }

    @Test
    void mapsCustomErrorNames() {
        assertEquals(ExactEvmErrors.VALID_BEFORE_EXPIRED, reason("reverted with AuthorizationExpired()"));
        assertEquals(ExactEvmErrors.VALID_AFTER_IN_FUTURE, reason("AuthorizationNotYetValid"));
        assertEquals(ExactEvmErrors.NONCE_ALREADY_USED, reason("AuthorizationAlreadyUsed"));
        assertEquals(ExactEvmErrors.NONCE_ALREADY_USED, reason("AuthorizationUsedOrCanceled"));
        assertEquals(ExactEvmErrors.INSUFFICIENT_BALANCE, reason("ERC20InsufficientBalance(0x1, 0, 1)"));
        assertEquals(ExactEvmErrors.INVALID_SIGNATURE, reason("SignerMismatch"));
        assertEquals(ExactEvmErrors.INVALID_SIGNATURE, reason("InvalidSignatureV"));
        assertEquals(ExactEvmErrors.INVALID_SIGNATURE, reason("InvalidSignatureS"));
    }

    @Test
    void fallsBackToFailedToExecuteTransfer() {
        assertEquals(ExactEvmErrors.FAILED_TO_EXECUTE_TRANSFER, reason("execution reverted: Pausable: paused"));
        assertEquals(ExactEvmErrors.FAILED_TO_EXECUTE_TRANSFER, reason("nonce too low"));
        // Matching is case-sensitive
        assertEquals(ExactEvmErrors.FAILED_TO_EXECUTE_TRANSFER, reason("INVALID SIGNATURE"));
        assertEquals(ExactEvmErrors.FAILED_TO_EXECUTE_TRANSFER, reason(null));
    }

    @Test
    void findsTheMatchingTransferEvent() {
        // Topic 0 is cast keccak 'Approval(address,address,uint256)'
        TransactionReceipt.Log approval = new TransactionReceipt.Log(BASE_SEPOLIA_USDC,
                List.of("0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", FROM_TOPIC, TO_TOPIC),
                VALUE_1000);
        TransactionReceipt.Log transfer = log(BASE_SEPOLIA_USDC.toLowerCase(Locale.ROOT),
                List.of(TRANSFER_TOPIC.toUpperCase(Locale.ROOT).replace("0X", "0x"), FROM_TOPIC, TO_TOPIC),
                VALUE_1000 + "00".repeat(32));

        assertTrue(Eip3009Token.hasTransferEvent(List.of(approval, transfer), BASE_SEPOLIA_USDC, AUTHORIZATION));
    }

    @Test
    void ignoresTransfersThatDoNotMatchTheAuthorization() {
        String otherToken = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
        List<TransactionReceipt.Log> mismatches = List.of(
                log(otherToken, List.of(TRANSFER_TOPIC, FROM_TOPIC, TO_TOPIC), VALUE_1000),
                log(BASE_SEPOLIA_USDC, List.of(TRANSFER_TOPIC, FROM_TOPIC), VALUE_1000),
                log(BASE_SEPOLIA_USDC, List.of(TRANSFER_TOPIC, TO_TOPIC, FROM_TOPIC), VALUE_1000),
                log(BASE_SEPOLIA_USDC, List.of(TRANSFER_TOPIC, FROM_TOPIC, FROM_TOPIC), VALUE_1000),
                log(BASE_SEPOLIA_USDC, List.of(TRANSFER_TOPIC, FROM_TOPIC, TO_TOPIC), "0x" + "00".repeat(30) + "03e7"),
                log(BASE_SEPOLIA_USDC, List.of(TRANSFER_TOPIC, FROM_TOPIC, TO_TOPIC), "0x03e8"));

        for (TransactionReceipt.Log mismatch : mismatches) {
            assertFalse(Eip3009Token.hasTransferEvent(List.of(mismatch), BASE_SEPOLIA_USDC, AUTHORIZATION),
                    mismatch.toString());
        }
        assertFalse(Eip3009Token.hasTransferEvent(List.of(), BASE_SEPOLIA_USDC, AUTHORIZATION));
    }

    private static TransactionReceipt.Log log(String address, List<String> topics, String data) {
        return new TransactionReceipt.Log(address, topics, data);
    }

    private static String reason(String message) {
        return Eip3009Token.reasonForTransferFailure(message);
    }
}
