package org.x402.mechanisms.evm.exact;

import org.x402.InMemoryPendingSettlementStore;
import org.x402.PendingSettlementStore;
import org.x402.X402Facilitator;
import org.x402.X402ResourceServer;
import org.x402.http.HttpFacilitatorClient;
import org.x402.mechanisms.evm.EvmConstants;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.Secp256k1;
import org.x402.mechanisms.evm.TypedDataDomain;
import org.x402.mechanisms.evm.Uint256;
import org.x402.mechanisms.evm.rpc.BroadcastOutcomeUnknownException;
import org.x402.mechanisms.evm.rpc.ContractRevertException;
import org.x402.mechanisms.evm.rpc.JsonRpcException;
import org.x402.mechanisms.evm.rpc.TransactionReceipt;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.types.VerifyResponse;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_CHAIN_ID;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_SIGNATURE;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.CastVectors.BASE_USDC;
import static org.x402.mechanisms.evm.CastVectors.NONCE;
import static org.x402.mechanisms.evm.CastVectors.VALID_BEFORE;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TRANSFER_TOPIC;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TWA_CALLDATA;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TWA_SELECTOR;

/**
 * Every verify and settle path of the exact EVM facilitator, driven through a scripted signer. The base payment is
 * the cast-signed Base Sepolia authorization of {@code CastVectors}: 1000 atomic USDC from anvil #0 to anvil #1,
 * valid before 1740672154.
 */
class ExactEvmFacilitatorSchemeTest {

    private static final String NETWORK = "eip155:84532";
    private static final long NOW = Long.parseLong(VALID_BEFORE) - 60;
    private static final Clock CLOCK = Clock.fixed(Instant.ofEpochSecond(NOW), ZoneOffset.UTC);
    private static final String TX_HASH = "0x" + "ab".repeat(32);
    private static final String UNRECOGNIZED_REVERT = "execution reverted: Pausable: paused";
    private static final String OTHER_TX_HASH = "0x" + "cd".repeat(32);

    /**
     * An ERC-6492 envelope with a factory and factory calldata around the cast-signed signature:
     * {@code cast abi-encode 'f(address,bytes,bytes)' 0x1111111111111111111111111111111111111111 0x1234
     * $BASE_SEPOLIA_SIGNATURE}.
     */
    private static final String ERC6492_ENVELOPE = "0x"
            + "0000000000000000000000001111111111111111111111111111111111111111"
            + "0000000000000000000000000000000000000000000000000000000000000060"
            + "00000000000000000000000000000000000000000000000000000000000000a0"
            + "0000000000000000000000000000000000000000000000000000000000000002"
            + "1234000000000000000000000000000000000000000000000000000000000000"
            + "0000000000000000000000000000000000000000000000000000000000000041"
            + "54b9f3b045b94aec7644428bf6cc9b5fe3217c0182b56eb2a2022563ef950f48"
            + "648ba7bfc320ad10aa747350221bb9ebb4f6c928eb68e54df2530555794c41a2"
            + "1c00000000000000000000000000000000000000000000000000000000000000";

    /** The ERC-6492 magic suffix, without {@code 0x}. */
    private static final String ERC6492_MAGIC = "6492".repeat(16);

    private FakeFacilitatorEvmSigner signer;
    private ExactEvmFacilitatorScheme scheme;

    @BeforeEach
    void setUp() {
        signer = new FakeFacilitatorEvmSigner().withCode(BASE_SEPOLIA_USDC, "0x6080");
        signer.receipt = receipt(true, List.of(transferLog(BASE_SEPOLIA_USDC, "03e8")));
        scheme = ExactEvmFacilitatorScheme.builder(signer).clock(CLOCK).build();
    }

    // ----------------------------------------------------------------------------------------------- metadata

    @Test
    void describesTheExactEvmScheme() {
        assertEquals("exact", scheme.scheme());
        assertEquals("eip155:*", scheme.caipFamily());
        assertNull(scheme.extra(NETWORK));
        assertEquals(List.of(FakeFacilitatorEvmSigner.FACILITATOR), scheme.signers(NETWORK));
    }

    @Test
    void validatesConstructorArguments() {
        ExactEvmFacilitatorScheme.Builder builder = ExactEvmFacilitatorScheme.builder(signer);
        assertThrows(IllegalArgumentException.class, () -> builder.receiptTimeout(Duration.ZERO));
        assertThrows(IllegalArgumentException.class, () -> builder.receiptTimeout(Duration.ofSeconds(-1)));
    }

    // ------------------------------------------------------------------------------------------- verify: valid

    @Test
    void acceptsAValidPayment() throws Exception {
        VerifyResponse response = scheme.verify(payload(), requirements());

        assertTrue(response.isValid());
        assertEquals(ANVIL_ADDRESS_0, response.payer());
        assertEquals(List.of(key(ANVIL_ADDRESS_0), key(BASE_SEPOLIA_USDC)), signer.codeRequests);
        assertEquals(List.of(key(BASE_SEPOLIA_USDC) + " " + TWA_CALLDATA), signer.calls);
        assertTrue(signer.sent.isEmpty());
    }

    @Test
    void acceptsTheBoundariesOfTheValidityWindow() throws Exception {
        Eip3009Authorization edges = authorization(ANVIL_ADDRESS_1, "1000", String.valueOf(NOW),
                String.valueOf(NOW + 6));

        assertTrue(scheme.verify(signed(edges, ANVIL_KEY_0), requirements()).isValid());
    }

    @Test
    void comparesTheRecipientIgnoringCase() throws Exception {
        PaymentRequirements lowercase = requirements().withExtra(Map.of("name", "USDC", "version", "2"));
        lowercase = new PaymentRequirements(lowercase.scheme(), lowercase.network(), lowercase.asset(),
                lowercase.amount(), ANVIL_ADDRESS_1.toLowerCase(Locale.ROOT), 300, lowercase.extra());

        assertTrue(scheme.verify(payload(lowercase), lowercase).isValid());
    }

    @Test
    void readsPayToAmountAndAssetFromTheRequirementsNotFromThePayersEcho() throws Exception {
        PaymentRequirements echo = withAsset(withPayTo(withAmount(requirements(), "1"), ANVIL_ADDRESS_0), "usdc");

        assertTrue(scheme.verify(payload(echo), requirements()).isValid());
    }

    // -------------------------------------------------------------------------------------- verify: rejections

    @Test
    void rejectsOtherSchemes() throws Exception {
        PaymentRequirements upto = withScheme(requirements(), "upto");

        assertInvalid(ExactEvmErrors.INVALID_SCHEME, null, "invalid scheme: upto",
                scheme.verify(payload(upto), requirements()));
        assertInvalid(ExactEvmErrors.INVALID_SCHEME, null, "invalid scheme: null",
                scheme.verify(new PaymentPayload(2, payloadMap(), null, null, null), requirements()));
    }

    @Test
    void rejectsANetworkMismatch() throws Exception {
        PaymentRequirements base = withNetwork(requirements(), "eip155:8453");

        assertInvalid(ExactEvmErrors.NETWORK_MISMATCH, null, "network mismatch: eip155:8453 != eip155:84532",
                scheme.verify(payload(base), requirements()));
    }

    @Test
    void rejectsMalformedPayloads() throws Exception {
        Map<String, Object> noAuthorization = Map.of("signature", BASE_SEPOLIA_SIGNATURE);
        Map<String, Object> badFrom = new LinkedHashMap<>(payloadMap());
        Map<String, Object> authorization = new LinkedHashMap<>(authorization().toMap());
        authorization.put("from", "0x1234");
        badFrom.put("authorization", authorization);

        assertInvalid(ExactEvmErrors.INVALID_PAYLOAD, null, "failed to parse EVM payload: authorization is missing",
                scheme.verify(payloadWith(noAuthorization), requirements()));
        assertInvalid(ExactEvmErrors.INVALID_PAYLOAD, null,
                "failed to parse EVM payload: authorization.from is not an EVM address",
                scheme.verify(payloadWith(badFrom), requirements()));
        assertInvalid(ExactEvmErrors.INVALID_PAYLOAD, null, "failed to parse EVM payload: authorization is missing",
                scheme.verify(payloadWith(null), requirements()));
    }

    @Test
    void rejectsAMissingSignature() throws Exception {
        Map<String, Object> empty = new LinkedHashMap<>(payloadMap());
        empty.put("signature", "");

        assertInvalid(ExactEvmErrors.MISSING_SIGNATURE, null, "missing signature",
                scheme.verify(payloadWith(Map.of("authorization", authorization().toMap())), requirements()));
        assertInvalid(ExactEvmErrors.MISSING_SIGNATURE, null, "missing signature",
                scheme.verify(payloadWith(empty), requirements()));
    }

    @Test
    void rejectsNetworksWithoutAnEvmChainId() throws Exception {
        PaymentRequirements solana = withNetwork(requirements(), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
        PaymentRequirements none = withNetwork(requirements(), null);

        VerifyResponse response = scheme.verify(payload(solana), solana);

        assertEquals(ExactEvmErrors.FAILED_TO_GET_NETWORK_CONFIG, response.invalidReason());
        assertTrue(response.invalidMessage().startsWith("Unsupported network: solana:"));
        assertEquals(ExactEvmErrors.FAILED_TO_GET_NETWORK_CONFIG, scheme.verify(payload(none), none).invalidReason());
    }

    @Test
    void rejectsNetworksTheSignerIsNotConnectedTo() throws Exception {
        signer.chainId = BigInteger.valueOf(8453);

        assertInvalid(ExactEvmErrors.FAILED_TO_GET_NETWORK_CONFIG, null,
                "facilitator signer is connected to chain 8453, not eip155:84532",
                scheme.verify(payload(), requirements()));
    }

    @Test
    void rejectsARecipientMismatch() throws Exception {
        PaymentRequirements other = withPayTo(requirements(), ANVIL_ADDRESS_0);

        assertInvalid(ExactEvmErrors.RECIPIENT_MISMATCH, null,
                "recipient mismatch: " + ANVIL_ADDRESS_1 + " != " + ANVIL_ADDRESS_0,
                scheme.verify(payload(), other));
    }

    @Test
    void rejectsAnInvalidRequiredAmount() throws Exception {
        for (String amount : new String[] {"1.5", "-1", "", null}) {
            PaymentRequirements bad = withAmount(requirements(), amount);

            assertInvalid(ExactEvmErrors.INVALID_REQUIRED_AMOUNT, null, "invalid required amount: " + amount,
                    scheme.verify(payload(), bad));
        }
    }

    @Test
    void rejectsAValueMismatch() throws Exception {
        PaymentRequirements more = withAmount(requirements(), "1001");

        assertInvalid(ExactEvmErrors.AUTHORIZATION_VALUE_MISMATCH, ANVIL_ADDRESS_0,
                "authorization value mismatch: 1000 != 1001", scheme.verify(payload(), more));
    }

    @Test
    void rejectsAnAuthorizationExpiringWithinSixSeconds() throws Exception {
        Eip3009Authorization expiring = authorization(ANVIL_ADDRESS_1, "1000", "0", String.valueOf(NOW + 5));

        assertInvalid(ExactEvmErrors.VALID_BEFORE_EXPIRED, ANVIL_ADDRESS_0, "valid before expired: " + (NOW + 5),
                scheme.verify(signed(expiring, ANVIL_KEY_0), requirements()));
    }

    @Test
    void rejectsAnAuthorizationNotYetValid() throws Exception {
        Eip3009Authorization future = authorization(ANVIL_ADDRESS_1, "1000", String.valueOf(NOW + 1), VALID_BEFORE);

        assertInvalid(ExactEvmErrors.VALID_AFTER_IN_FUTURE, ANVIL_ADDRESS_0, "valid after in future: " + (NOW + 1),
                scheme.verify(signed(future, ANVIL_KEY_0), requirements()));
    }

    @Test
    void rejectsRequirementsWithoutTheEip712Domain() throws Exception {
        Map<String, Object> numericVersion = new HashMap<>();
        numericVersion.put("name", "USDC");
        numericVersion.put("version", 2);
        List<Map<String, Object>> extras = List.of(Map.of("version", "2"), Map.of("name", "", "version", "2"),
                Map.of("name", "USDC"), numericVersion);

        for (Map<String, Object> extra : extras) {
            assertInvalid(ExactEvmErrors.MISSING_EIP712_DOMAIN, ANVIL_ADDRESS_0,
                    "missing EIP-712 domain name/version in requirements.extra",
                    scheme.verify(payload(), requirements().withExtra(extra)));
        }
        assertEquals(ExactEvmErrors.MISSING_EIP712_DOMAIN,
                scheme.verify(payload(), requirements().withExtra(null)).invalidReason());
    }

    @Test
    void rejectsASignatureThatIsNotHex() throws Exception {
        VerifyResponse response = scheme.verify(payloadSignedWith("0xzz"), requirements());

        assertEquals(ExactEvmErrors.INVALID_SIGNATURE_FORMAT, response.invalidReason());
        assertEquals(ANVIL_ADDRESS_0, response.payer());
        assertTrue(signer.codeRequests.isEmpty());
    }

    @Test
    void rejectsAnAssetThatIsNotAnAddress() throws Exception {
        PaymentRequirements bad = withAsset(requirements(), "usdc");

        assertInvalid(ExactEvmErrors.ASSET_NOT_DEPLOYED_CONTRACT, ANVIL_ADDRESS_0, "asset usdc is not an EVM address",
                scheme.verify(payload(), bad));
    }

    @Test
    void reportsAPayerCodeLookupFailureAsUnverifiable() throws Exception {
        signer.codeFailures.put(key(ANVIL_ADDRESS_0), new IOException("eth_getCode: request failed"));

        assertInvalid(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE, ANVIL_ADDRESS_0, "eth_getCode: request failed",
                scheme.verify(payload(), requirements()));
    }

    @Test
    void rejectsHighSSignaturesOfExternallyOwnedAccounts() throws Exception {
        assertInvalid(ExactEvmErrors.INVALID_SIGNATURE_S, ANVIL_ADDRESS_0, "invalid signature s",
                scheme.verify(payloadSignedWith(highS(BASE_SEPOLIA_SIGNATURE)), requirements()));
    }

    @Test
    void rejectsSmartWalletPayersAsUnsupported() throws Exception {
        signer.withCode(ANVIL_ADDRESS_0, "0xef0100" + "11".repeat(20));

        // A payer with bytecode is rejected whether or not its signature has a low s
        VerifyResponse highS = scheme.verify(payloadSignedWith(highS(BASE_SEPOLIA_SIGNATURE)), requirements());
        VerifyResponse lowS = scheme.verify(payload(), requirements());

        assertEquals(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE, highS.invalidReason());
        assertInvalid(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE, ANVIL_ADDRESS_0,
                "payer has bytecode: smart-contract wallet (ERC-1271) signatures are not supported", lowS);
    }

    @Test
    void rejectsErc6492DeploymentEnvelopes() throws Exception {
        assertInvalid(ExactEvmErrors.FACTORY_NOT_ALLOWED, ANVIL_ADDRESS_0,
                "counterfactual wallet (ERC-6492) signatures are not supported",
                scheme.verify(payloadSignedWith(ERC6492_ENVELOPE + ERC6492_MAGIC), requirements()));
    }

    @Test
    void rejectsUndecodableErc6492EnvelopesAsFactoryNotAllowed() throws Exception {
        String undecodable = "0x" + "11".repeat(96) + ERC6492_MAGIC;

        assertEquals(ExactEvmErrors.FACTORY_NOT_ALLOWED,
                scheme.verify(payloadSignedWith(undecodable), requirements()).invalidReason());
    }

    @Test
    void rejectsSignaturesThatAreNotEcdsa() throws Exception {
        String sixtyFourBytes = BASE_SEPOLIA_SIGNATURE.substring(0, 130);
        String badV = BASE_SEPOLIA_SIGNATURE.substring(0, 130) + "1d";
        String zeroR = "0x" + "00".repeat(32) + BASE_SEPOLIA_SIGNATURE.substring(66);

        assertInvalid(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE, ANVIL_ADDRESS_0, "Signature must be 65 bytes, got 64",
                scheme.verify(payloadSignedWith(sixtyFourBytes), requirements()));
        assertInvalid(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE, ANVIL_ADDRESS_0,
                "Signature v must be 27, 28, 0 or 1, got 29", scheme.verify(payloadSignedWith(badV), requirements()));
        assertEquals(ExactEvmErrors.FAILED_TO_VERIFY_SIGNATURE,
                scheme.verify(payloadSignedWith(zeroR), requirements()).invalidReason());
    }

    @Test
    void rejectsASignatureOfAnotherAccount() throws Exception {
        VerifyResponse response = scheme.verify(signed(authorization(), ANVIL_KEY_1), requirements());

        assertInvalid(ExactEvmErrors.INVALID_SIGNATURE, ANVIL_ADDRESS_0,
                "invalid signature: recovered signer " + ANVIL_ADDRESS_1, response);
    }

    @Test
    void rejectsASignatureOverAnotherDomain() throws Exception {
        PaymentRequirements usdCoin = requirements().withExtra(Map.of("name", "USD Coin", "version", "2"));

        assertEquals(ExactEvmErrors.INVALID_SIGNATURE, scheme.verify(payload(usdCoin), usdCoin).invalidReason());
    }

    @Test
    void rejectsAnAssetWithoutBytecode() throws Exception {
        signer.codes.clear();

        assertInvalid(ExactEvmErrors.ASSET_NOT_DEPLOYED_CONTRACT, ANVIL_ADDRESS_0,
                "asset " + BASE_SEPOLIA_USDC + " is not a deployed contract",
                scheme.verify(payload(), requirements()));
        assertTrue(signer.calls.isEmpty());
    }

    @Test
    void propagatesAnAssetCodeLookupFailure() {
        signer.codeFailures.put(key(BASE_SEPOLIA_USDC), new IOException("eth_getCode: HTTP status 503"));

        IOException e = assertThrows(IOException.class, () -> scheme.verify(payload(), requirements()));

        assertEquals("eth_getCode: HTTP status 503", e.getMessage());
    }

    // ------------------------------------------------------------------------------------ verify: simulation

    @Test
    void mapsSimulationRevertsToTheirReason() throws Exception {
        Map<String, String> reverts = Map.of(
                "execution reverted: FiatTokenV2: authorization is expired", ExactEvmErrors.VALID_BEFORE_EXPIRED,
                "execution reverted: FiatTokenV2: authorization is not yet valid", ExactEvmErrors.VALID_AFTER_IN_FUTURE,
                "execution reverted: FiatTokenV2: authorization is used or canceled", ExactEvmErrors.NONCE_ALREADY_USED,
                "execution reverted: ERC20: transfer amount exceeds balance", ExactEvmErrors.INSUFFICIENT_BALANCE,
                "execution reverted: FiatTokenV2: invalid signature", ExactEvmErrors.INVALID_SIGNATURE);

        for (Map.Entry<String, String> revert : reverts.entrySet()) {
            signer.calls.clear();
            signer.callHandler = (to, data) -> {
                throw new ContractRevertException(revert.getKey(), new byte[0]);
            };

            VerifyResponse response = scheme.verify(payload(), requirements());

            assertInvalid(revert.getValue(), ANVIL_ADDRESS_0, revert.getKey(), response);
            assertEquals(1, signer.calls.size(), "a recognized revert needs no diagnosis");
        }
    }

    @Test
    void keepsTheRetryableReasonForTransportFailuresWithoutProbing() throws Exception {
        signer.callHandler = (to, data) -> {
            throw new IOException("eth_call: request failed: java.net.ConnectException");
        };

        assertInvalid(ExactEvmErrors.EIP3009_SIMULATION_FAILED, ANVIL_ADDRESS_0,
                "eth_call: request failed: java.net.ConnectException", scheme.verify(payload(), requirements()));
        assertEquals(1, signer.calls.size());
    }

    @Test
    void diagnosesUnrecognizedRevertsAsUnsupportedWhenAuthorizationStateReverts() throws Exception {
        signer.callHandler = token(null, "USDC", "2", 1000);

        assertInvalid(ExactEvmErrors.EIP3009_NOT_SUPPORTED, ANVIL_ADDRESS_0, UNRECOGNIZED_REVERT,
                scheme.verify(payload(), requirements()));
        assertEquals(List.of(TWA_SELECTOR, "0xe94a0102"), signer.calledSelectors());
    }

    @Test
    void diagnosesUnrecognizedRevertsAsUnsupportedWhenAuthorizationStateIsNotABool() throws Exception {
        FakeFacilitatorEvmSigner.CallHandler base = token(false, "USDC", "2", 1000);
        signer.callHandler = (to, data) ->
                Hex.encode(data).startsWith("0xe94a0102") ? new byte[0] : base.call(to, data);

        assertEquals(ExactEvmErrors.EIP3009_NOT_SUPPORTED, scheme.verify(payload(), requirements()).invalidReason());
    }

    @Test
    void diagnosesAUsedNonce() throws Exception {
        signer.callHandler = token(true, "USDC", "2", 1000);

        assertEquals(ExactEvmErrors.NONCE_ALREADY_USED, scheme.verify(payload(), requirements()).invalidReason());
    }

    @Test
    void diagnosesATokenNameMismatch() throws Exception {
        signer.callHandler = token(false, "USD Coin", "2", 1000);

        assertEquals(ExactEvmErrors.EIP3009_TOKEN_NAME_MISMATCH,
                scheme.verify(payload(), requirements()).invalidReason());
    }

    @Test
    void diagnosesATokenVersionMismatch() throws Exception {
        signer.callHandler = token(false, "USDC", "1", 1000);

        assertEquals(ExactEvmErrors.EIP3009_TOKEN_VERSION_MISMATCH,
                scheme.verify(payload(), requirements()).invalidReason());
    }

    @Test
    void diagnosesAnInsufficientBalance() throws Exception {
        signer.callHandler = token(false, "USDC", "2", 999);

        assertEquals(ExactEvmErrors.INSUFFICIENT_BALANCE, scheme.verify(payload(), requirements()).invalidReason());
        assertEquals(List.of(TWA_SELECTOR, "0xe94a0102", "0x06fdde03", "0x54fd4d50",
                "0x70a08231"), signer.calledSelectors());
    }

    @Test
    void fallsBackToSimulationFailedWhenTheDiagnosisFindsNothing() throws Exception {
        signer.callHandler = token(false, "USDC", "2", 1000);

        assertEquals(ExactEvmErrors.EIP3009_SIMULATION_FAILED,
                scheme.verify(payload(), requirements()).invalidReason());
    }

    @Test
    void skipsDiagnosticReadsThatReturnNothingUseful() throws Exception {
        FakeFacilitatorEvmSigner.CallHandler base = token(false, "USDC", "2", 1000);
        signer.callHandler = (to, data) -> {
            String selector = Hex.encode(data).substring(0, 10);
            if (selector.equals("0x06fdde03")) {
                throw new ContractRevertException("execution reverted", new byte[0]);
            }
            if (selector.equals("0x54fd4d50") || selector.equals("0x70a08231")) {
                return new byte[3];
            }
            return base.call(to, data);
        };

        assertEquals(ExactEvmErrors.EIP3009_SIMULATION_FAILED,
                scheme.verify(payload(), requirements()).invalidReason());
    }

    @Test
    void fallsBackToSimulationFailedWhenTheDiagnosisCannotReachTheNode() throws Exception {
        FakeFacilitatorEvmSigner.CallHandler base = token(false, "USDC", "2", 1000);
        signer.callHandler = (to, data) -> {
            if (Hex.encode(data).startsWith("0x06fdde03")) {
                throw new JsonRpcException("eth_call", -32000, "header not found", null);
            }
            return base.call(to, data);
        };

        assertEquals(ExactEvmErrors.EIP3009_SIMULATION_FAILED,
                scheme.verify(payload(), requirements()).invalidReason());
    }

    // ---------------------------------------------------------------------------------------------- settle

    @Test
    void settlesAValidPayment() throws Exception {
        SettleResponse response = scheme.settle(payload(), requirements());

        assertTrue(response.success());
        assertEquals(ANVIL_ADDRESS_0, response.payer());
        assertEquals(TX_HASH, response.transaction());
        assertEquals(NETWORK, response.network());
        assertNull(response.errorReason());
        assertEquals(List.of(key(BASE_SEPOLIA_USDC) + " " + TWA_CALLDATA), signer.sent);
        assertTrue(signer.calls.isEmpty(), "settle does not simulate by default");
        assertEquals(ExactEvmFacilitatorScheme.DEFAULT_RECEIPT_TIMEOUT, signer.receiptTimeout);
    }

    @Test
    void simulatesInSettleWhenConfigured() throws Exception {
        ExactEvmFacilitatorScheme simulating = ExactEvmFacilitatorScheme.builder(signer)
                .clock(CLOCK).simulateInSettle(true).receiptTimeout(Duration.ofSeconds(7)).build();
        signer.callHandler = (to, data) -> {
            throw new ContractRevertException("execution reverted: FiatTokenV2: authorization is used or canceled",
                    new byte[0]);
        };

        SettleResponse response = simulating.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.NONCE_ALREADY_USED, "", response);
        assertTrue(signer.sent.isEmpty());

        signer.callHandler = (to, data) -> new byte[0];
        assertTrue(simulating.settle(payload(), requirements()).success());
        assertEquals(Duration.ofSeconds(7), signer.receiptTimeout);
    }

    @Test
    void reportsTheVerifyReasonWhenThePaymentIsInvalid() throws Exception {
        PaymentRequirements more = withAmount(requirements(), "1001");

        SettleResponse response = scheme.settle(payload(), more);

        assertFailure(ExactEvmErrors.AUTHORIZATION_VALUE_MISMATCH, "", response);
        assertEquals("authorization value mismatch: 1000 != 1001", response.errorMessage());
        assertEquals(ANVIL_ADDRESS_0, response.payer());
        assertEquals(NETWORK, response.network());
        assertTrue(signer.sent.isEmpty());
    }

    @Test
    void settleRejectsAnAuthorizationThatExpiredSinceVerify() throws Exception {
        Eip3009Authorization expiring = authorization(ANVIL_ADDRESS_1, "1000", "0", String.valueOf(NOW + 5));

        SettleResponse response = scheme.settle(signed(expiring, ANVIL_KEY_0), requirements());

        assertFailure(ExactEvmErrors.VALID_BEFORE_EXPIRED, "", response);
        assertTrue(signer.sent.isEmpty());
    }

    @Test
    void settleRejectsASignatureOfAnotherAccount() throws Exception {
        SettleResponse response = scheme.settle(signed(authorization(), ANVIL_KEY_1), requirements());

        assertFailure(ExactEvmErrors.INVALID_SIGNATURE, "", response);
        assertTrue(signer.sent.isEmpty());
    }

    @Test
    void reportsVerificationFailedWhenTheChainCannotBeQueried() throws Exception {
        signer.codeFailures.put(key(BASE_SEPOLIA_USDC), new IOException("eth_getCode: HTTP status 503"));

        SettleResponse response = scheme.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.VERIFICATION_FAILED, "", response);
        assertEquals("eth_getCode: HTTP status 503", response.errorMessage());
        assertNull(response.payer());
    }

    @Test
    void reportsTheRequirementsNetworkWhenNoneWasAccepted() throws Exception {
        SettleResponse response = scheme.settle(new PaymentPayload(2, payloadMap(), null, null, null), requirements());

        assertFailure(ExactEvmErrors.INVALID_SCHEME, "", response);
        assertEquals(NETWORK, response.network());
    }

    @Test
    void mapsARevertingTransactionToItsReason() throws Exception {
        signer.sendFailure = new ContractRevertException(
                "execution reverted: FiatTokenV2: authorization is used or canceled", new byte[0]);

        SettleResponse response = scheme.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.NONCE_ALREADY_USED, "", response);
        assertEquals("execution reverted: FiatTokenV2: authorization is used or canceled", response.errorMessage());
    }

    @Test
    void reportsATransactionThatCannotBeSent() throws Exception {
        signer.sendFailure = new JsonRpcException("eth_sendRawTransaction", -32000, "nonce too low", null);

        SettleResponse response = scheme.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.FAILED_TO_EXECUTE_TRANSFER, "", response);
        assertEquals("eth_sendRawTransaction: nonce too low (code -32000)", response.errorMessage());
    }

    @Test
    void rejectsInvalidTransactionHashesFromTheSigner() throws Exception {
        String[] hashes = {null, "0x" + "00".repeat(32), "0x1234", "ab".repeat(33), "0x" + "zz".repeat(32)};
        for (String hash : hashes) {
            signer.sentHash = hash;

            SettleResponse response = scheme.settle(payload(), requirements());

            assertFailure(ExactEvmErrors.TRANSACTION_FAILED, "", response);
            assertEquals("signer returned an invalid transaction hash", response.errorMessage());
        }
    }

    @Test
    void reportsAPendingSettlementWhenTheReceiptIsLate() throws Exception {
        signer.receiptFailure = new IOException("No receipt within PT2M; " + "x".repeat(600));

        SettleResponse response = scheme.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.SETTLEMENT_PENDING, TX_HASH, response);
        assertEquals(500, response.errorMessage().length());
        assertEquals(ANVIL_ADDRESS_0, response.payer());
    }

    @Test
    void reportsAPendingSettlementAndKeepsTheInterruptWhenInterrupted() throws Exception {
        signer.interruptReceiptWait = true;

        SettleResponse response = scheme.settle(payload(), requirements());

        assertTrue(Thread.interrupted(), "the interrupt flag must be restored");
        assertFailure(ExactEvmErrors.SETTLEMENT_PENDING, TX_HASH, response);
        assertEquals("interrupted while waiting for the receipt", response.errorMessage());
    }

    @Test
    void reportsAPendingSettlementWithTheLocalHashWhenTheBroadcastReplyIsLost() throws Exception {
        signer.sendFailure = new BroadcastOutcomeUnknownException(OTHER_TX_HASH,
                "eth_sendRawTransaction: no response within PT30S; transaction " + OTHER_TX_HASH
                        + " may still be mined", null);

        SettleResponse response = scheme.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.SETTLEMENT_PENDING, OTHER_TX_HASH, response);
        assertEquals(ANVIL_ADDRESS_0, response.payer());
        assertTrue(signer.receiptWaits.isEmpty());

        signer.sendFailure = null;
        SettleResponse retried = scheme.settle(payload(), requirements());

        assertTrue(retried.success());
        assertEquals(OTHER_TX_HASH, retried.transaction());
        assertEquals(List.of(OTHER_TX_HASH), signer.receiptWaits);
        assertEquals(1, signer.sent.size());
    }

    @Test
    void waitsLessThanTheFacilitatorClientTimeoutByDefault() {
        assertTrue(ExactEvmFacilitatorScheme.DEFAULT_RECEIPT_TIMEOUT.compareTo(HttpFacilitatorClient.DEFAULT_TIMEOUT)
                < 0);
    }

    // ----------------------------------------------------------------------------- settle: pending settlements

    @Test
    void reconcilesARetryAgainstThePendingTransactionWithoutBroadcastingAgain() throws Exception {
        signer.nextReceiptFailures.add(new IOException("No receipt within PT1M"));

        SettleResponse first = scheme.settle(payload(), requirements());
        SettleResponse retried = scheme.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.SETTLEMENT_PENDING, TX_HASH, first);
        assertTrue(retried.success());
        assertEquals(TX_HASH, retried.transaction());
        assertEquals(ANVIL_ADDRESS_0, retried.payer());
        assertEquals(1, signer.sent.size());
        assertEquals(List.of(TX_HASH, TX_HASH), signer.receiptWaits);
        assertEquals(List.of(key(ANVIL_ADDRESS_0), key(BASE_SEPOLIA_USDC)), signer.codeRequests,
                "the retry does not verify again");
    }

    @Test
    void keepsReconcilingWhileTheTransactionStaysPending() throws Exception {
        signer.nextReceiptFailures.add(new IOException("No receipt within PT1M"));
        signer.nextReceiptFailures.add(new IOException("No receipt within PT1M"));

        scheme.settle(payload(), requirements());
        SettleResponse second = scheme.settle(payload(), requirements());
        SettleResponse third = scheme.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.SETTLEMENT_PENDING, TX_HASH, second);
        assertTrue(third.success());
        assertEquals(1, signer.sent.size());
    }

    @Test
    void removesThePendingEntryBeforeReconcilingAndOnceAReceiptArrives() throws Exception {
        RecordingStore store = new RecordingStore();
        ExactEvmFacilitatorScheme recording =
                ExactEvmFacilitatorScheme.builder(signer).clock(CLOCK).pendingSettlementStore(store).build();
        signer.nextReceiptFailures.add(new IOException("No receipt within PT1M"));

        recording.settle(payload(), requirements());
        recording.settle(payload(), requirements());

        String sig = BASE_SEPOLIA_SIGNATURE;
        assertEquals(List.of("get " + sig, "put " + sig + " " + TX_HASH, "get " + sig, "remove " + sig,
                "remove " + sig), store.operations);
        assertTrue(store.get(BASE_SEPOLIA_SIGNATURE).isEmpty());
    }

    @Test
    void reportsAReconciledRevertAsTransactionFailed() throws Exception {
        signer.nextReceiptFailures.add(new IOException("No receipt within PT1M"));
        scheme.settle(payload(), requirements());
        signer.receipt = receipt(false, List.of());

        assertFailure(ExactEvmErrors.TRANSACTION_FAILED, TX_HASH, scheme.settle(payload(), requirements()));
        assertEquals(1, signer.sent.size());
    }

    @Test
    void checksTheTransferEventOfAReconciledTransactionAgainstTheRequirementsAsset() throws Exception {
        signer.nextReceiptFailures.add(new IOException("No receipt within PT1M"));
        scheme.settle(payload(), requirements());

        SettleResponse response = scheme.settle(payload(), withAsset(requirements(), BASE_USDC));

        assertFailure(ExactEvmErrors.TRANSFER_EVENT_MISMATCH, TX_HASH, response);
    }

    @Test
    void rejectsAnInvalidHashFoundInThePendingStore() throws Exception {
        InMemoryPendingSettlementStore store = new InMemoryPendingSettlementStore();
        store.put(BASE_SEPOLIA_SIGNATURE, "0x1234");
        ExactEvmFacilitatorScheme withStore =
                ExactEvmFacilitatorScheme.builder(signer).clock(CLOCK).pendingSettlementStore(store).build();

        SettleResponse response = withStore.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.TRANSACTION_FAILED, "", response);
        assertEquals("signer returned an invalid transaction hash", response.errorMessage());
        assertTrue(signer.sent.isEmpty());
        assertTrue(store.get(BASE_SEPOLIA_SIGNATURE).isEmpty());
    }

    @Test
    void reportsAFinalFailureWithTheHashWhenThePendingEntryCannotBeStored() throws Exception {
        RecordingStore store = new RecordingStore();
        store.failure = new IOException("redis: connection refused");
        ExactEvmFacilitatorScheme failing =
                ExactEvmFacilitatorScheme.builder(signer).clock(CLOCK).pendingSettlementStore(store).build();
        signer.receiptFailure = new IOException("No receipt within PT1M");

        SettleResponse response = failing.settle(payload(), requirements());

        assertFailure(ExactEvmErrors.TRANSACTION_FAILED, TX_HASH, response);
        assertEquals("settlement_pending, but failed to persist for retry: redis: connection refused",
                response.errorMessage());
    }

    @Test
    void settlesNormallyWhenThePendingStoreCannotBeRead() throws Exception {
        RecordingStore store = new RecordingStore();
        store.failure = new IOException("redis: connection refused");
        ExactEvmFacilitatorScheme failing =
                ExactEvmFacilitatorScheme.builder(signer).clock(CLOCK).pendingSettlementStore(store).build();

        assertTrue(failing.settle(payload(), requirements()).success());
        assertEquals(1, signer.sent.size());
    }

    @Test
    void reconcilesTheResourceServersRetryThroughTheInProcessFacilitator() throws Exception {
        X402ResourceServer server = X402ResourceServer.builder()
                .register(NETWORK, new ExactEvmServerScheme())
                .facilitator(X402Facilitator.builder().register(List.of(NETWORK), scheme).build())
                .build();
        server.initialize();
        signer.nextReceiptFailures.add(new IOException("No receipt within PT1M"));

        SettleResponse response = server.settle(payload(), requirements());

        assertTrue(response.success());
        assertEquals(TX_HASH, response.transaction());
        assertEquals(1, signer.sent.size());
        assertEquals(List.of(TX_HASH, TX_HASH), signer.receiptWaits);
    }

    @Test
    void reportsTheSchemesNetworkMismatchThroughTheInProcessFacilitator() throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(NETWORK), scheme).build();

        VerifyResponse verify = facilitator.verify(payload(withNetwork(requirements(), "eip155:8453")), requirements());

        assertEquals(ExactEvmErrors.NETWORK_MISMATCH, verify.invalidReason());
    }

    @Test
    void reportsARevertedTransaction() throws Exception {
        signer.receipt = receipt(false, List.of());

        assertFailure(ExactEvmErrors.TRANSACTION_FAILED, TX_HASH, scheme.settle(payload(), requirements()));
    }

    @Test
    void rejectsAReceiptWithoutTheExpectedTransfer() throws Exception {
        List<List<TransactionReceipt.Log>> receipts = List.of(
                List.of(),
                List.of(transferLog("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "03e8")),
                List.of(transferLog(BASE_SEPOLIA_USDC, "03e7")));

        for (List<TransactionReceipt.Log> logs : receipts) {
            signer.receipt = receipt(true, logs);

            assertFailure(ExactEvmErrors.TRANSFER_EVENT_MISMATCH, TX_HASH, scheme.settle(payload(), requirements()));
        }
    }

    @Test
    void skipsTheTransferCheckWhenTheSignerReportsNoLogs() throws Exception {
        signer.receipt = receipt(true, null);

        assertTrue(scheme.settle(payload(), requirements()).success());
    }

    @Test
    void truncatesMultiByteMessagesOnCodePointBoundaries() throws Exception {
        signer.receiptFailure = new IOException("₮".repeat(400) + "😀".repeat(200));

        String message = scheme.settle(payload(), requirements()).errorMessage();

        assertEquals(500, message.codePointCount(0, message.length()));
        assertTrue(message.endsWith("😀"));
    }

    // --------------------------------------------------------------------------------------------- helpers

    private static PaymentRequirements requirements() {
        return new PaymentRequirements("exact", NETWORK, BASE_SEPOLIA_USDC, "1000", ANVIL_ADDRESS_1, 300,
                Map.of("name", "USDC", "version", "2"));
    }

    private static Eip3009Authorization authorization() {
        return authorization(ANVIL_ADDRESS_1, "1000", "0", VALID_BEFORE);
    }

    private static Eip3009Authorization authorization(String to, String value, String validAfter, String validBefore) {
        return new Eip3009Authorization(ANVIL_ADDRESS_0, to, value, validAfter, validBefore, NONCE);
    }

    private static Map<String, Object> payloadMap() {
        return new ExactEvmPayload(BASE_SEPOLIA_SIGNATURE, authorization()).toMap();
    }

    /** The cast-signed payment, accepted as {@code accepted}. */
    private static PaymentPayload payload(PaymentRequirements accepted) {
        return new PaymentPayload(2, payloadMap(), accepted, null, null);
    }

    private static PaymentPayload payload() {
        return payload(requirements());
    }

    private static PaymentPayload payloadWith(Map<String, Object> schemePayload) {
        return new PaymentPayload(2, schemePayload, requirements(), null, null);
    }

    private static PaymentPayload payloadSignedWith(String signature) {
        return payloadWith(new ExactEvmPayload(signature, authorization()).toMap());
    }

    /** Signs an authorization under Base Sepolia USDC's domain. */
    private static PaymentPayload signed(Eip3009Authorization authorization, String key) {
        byte[] signature = PrivateKeyEvmSigner.fromHex(key).signTypedData(
                new TypedDataDomain("USDC", "2", BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC),
                EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS, EvmConstants.TRANSFER_WITH_AUTHORIZATION,
                authorization.toMap());
        return payloadWith(new ExactEvmPayload(Hex.encode(signature), authorization).toMap());
    }

    /** The malleable twin of a signature: {@code s' = n - s} with the other recovery id. */
    private static String highS(String signature) {
        Secp256k1.Signature low = Secp256k1.Signature.fromBytes(Hex.decode(signature));
        byte[] high = new Secp256k1.Signature(low.r(), Secp256k1.CURVE_ORDER.subtract(low.s()),
                1 - low.recoveryId()).toBytes();
        return Hex.encode(high);
    }

    /**
     * A token whose simulated transfer reverts with an unrecognized reason and whose diagnostic reads return the given
     * state; a {@code null} nonce state makes {@code authorizationState} revert.
     */
    private static FakeFacilitatorEvmSigner.CallHandler token(Boolean nonceUsed, String name, String version,
            long balance) {
        return (to, data) -> {
            String selector = Hex.encode(data).substring(0, 10);
            switch (selector) {
                case "0xe3ee160e":
                    throw new ContractRevertException(UNRECOGNIZED_REVERT, new byte[0]);
                case "0xe94a0102":
                    if (nonceUsed == null) {
                        throw new ContractRevertException("execution reverted", new byte[0]);
                    }
                    return Uint256.toBytes(nonceUsed ? BigInteger.ONE : BigInteger.ZERO);
                case "0x06fdde03":
                    return abiString(name);
                case "0x54fd4d50":
                    return abiString(version);
                case "0x70a08231":
                    return Uint256.toBytes(BigInteger.valueOf(balance));
                default:
                    throw new AssertionError("unexpected call " + selector);
            }
        };
    }

    private static byte[] abiString(String value) {
        byte[] text = value.getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[96];
        out[31] = 0x20;
        out[63] = (byte) text.length;
        System.arraycopy(text, 0, out, 64, text.length);
        return out;
    }

    private static TransactionReceipt receipt(boolean successful, List<TransactionReceipt.Log> logs) {
        return new TransactionReceipt(TX_HASH, 42, successful, logs);
    }

    private static TransactionReceipt.Log transferLog(String token, String valueHex) {
        return new TransactionReceipt.Log(token, List.of(TRANSFER_TOPIC,
                "0x" + "00".repeat(12) + ANVIL_ADDRESS_0.substring(2),
                "0x" + "00".repeat(12) + ANVIL_ADDRESS_1.substring(2)),
                "0x" + "0".repeat(64 - valueHex.length()) + valueHex);
    }

    private static PaymentRequirements withScheme(PaymentRequirements r, String scheme) {
        return new PaymentRequirements(scheme, r.network(), r.asset(), r.amount(), r.payTo(), r.maxTimeoutSeconds(),
                r.extra());
    }

    private static PaymentRequirements withNetwork(PaymentRequirements r, String network) {
        return new PaymentRequirements(r.scheme(), network, r.asset(), r.amount(), r.payTo(), r.maxTimeoutSeconds(),
                r.extra());
    }

    private static PaymentRequirements withAsset(PaymentRequirements r, String asset) {
        return new PaymentRequirements(r.scheme(), r.network(), asset, r.amount(), r.payTo(), r.maxTimeoutSeconds(),
                r.extra());
    }

    private static PaymentRequirements withAmount(PaymentRequirements r, String amount) {
        return new PaymentRequirements(r.scheme(), r.network(), r.asset(), amount, r.payTo(), r.maxTimeoutSeconds(),
                r.extra());
    }

    private static PaymentRequirements withPayTo(PaymentRequirements r, String payTo) {
        return new PaymentRequirements(r.scheme(), r.network(), r.asset(), r.amount(), payTo, r.maxTimeoutSeconds(),
                r.extra());
    }

    private static String key(String address) {
        return FakeFacilitatorEvmSigner.key(address);
    }

    private static void assertInvalid(String reason, String payer, String message, VerifyResponse response) {
        assertFalse(response.isValid());
        assertEquals(reason, response.invalidReason());
        assertEquals(payer, response.payer());
        assertEquals(message, response.invalidMessage());
    }

    private static void assertFailure(String reason, String transaction, SettleResponse response) {
        assertFalse(response.success());
        assertEquals(reason, response.errorReason());
        assertEquals(transaction, response.transaction());
        assertEquals(NETWORK, response.network());
    }

    /** An in-memory store that records every operation and, once {@link #failure} is set, fails them all. */
    private static final class RecordingStore implements PendingSettlementStore {

        private final InMemoryPendingSettlementStore delegate = new InMemoryPendingSettlementStore();
        private final List<String> operations = new ArrayList<>();
        private IOException failure;

        @Override
        public Optional<String> get(String key) throws IOException {
            record("get " + key);
            return delegate.get(key);
        }

        @Override
        public void put(String key, String transactionHash) throws IOException {
            record("put " + key + " " + transactionHash);
            delegate.put(key, transactionHash);
        }

        @Override
        public void remove(String key) throws IOException {
            record("remove " + key);
            delegate.remove(key);
        }

        private void record(String operation) throws IOException {
            operations.add(operation);
            if (failure != null) {
                throw failure;
            }
        }
    }
}
