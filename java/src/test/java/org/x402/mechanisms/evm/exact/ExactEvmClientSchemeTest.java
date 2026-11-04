package org.x402.mechanisms.evm.exact;

import org.junit.jupiter.api.Test;
import org.mockito.AdditionalAnswers;
import org.mockito.ArgumentCaptor;
import org.x402.AssetAmount;
import org.x402.PaymentException;
import org.x402.Price;
import org.x402.X402;
import org.x402.mechanisms.evm.ClientEvmSigner;
import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.EvmConstants;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.Secp256k1;
import org.x402.mechanisms.evm.TypedDataDomain;
import org.x402.mechanisms.evm.Uint256;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.util.Json;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalInt;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.random.RandomGenerator;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
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

class ExactEvmClientSchemeTest {

    private static final String BASE_SEPOLIA = "eip155:84532";
    private static final String BASE = "eip155:8453";
    private static final int MAX_TIMEOUT_SECONDS = 300;
    /** {@code VALID_BEFORE - MAX_TIMEOUT_SECONDS}, so the cast vector's {@code validBefore} is reproduced. */
    private static final Clock CLOCK =
            Clock.fixed(Instant.ofEpochSecond(Long.parseLong(VALID_BEFORE) - MAX_TIMEOUT_SECONDS), ZoneOffset.UTC);
    private static final Pattern NONCE_FORMAT = Pattern.compile("0x[0-9a-f]{64}");
    /** An address outside the default-asset table. */
    private static final String CUSTOM_TOKEN = "0x0000000000000000000000000000000000000001";

    @Test
    void signsTheAuthorizationCastSigned() {
        ExactEvmClientScheme scheme =
                new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0), CLOCK, fixedBytes(NONCE));

        Map<String, Object> payload = scheme.createPaymentPayload(baseSepolia(Map.of("name", "USDC", "version", "2")));

        assertEquals("{\"signature\":\"" + BASE_SEPOLIA_SIGNATURE + "\","
                + "\"authorization\":{\"from\":\"" + ANVIL_ADDRESS_0 + "\",\"to\":\"" + ANVIL_ADDRESS_1 + "\","
                + "\"value\":\"1000\",\"validAfter\":\"0\",\"validBefore\":\"" + VALID_BEFORE + "\","
                + "\"nonce\":\"" + NONCE + "\"}}", Json.write(payload));
        assertThrows(UnsupportedOperationException.class, () -> payload.put("signature", "0x"));
    }

    @Test
    void fallsBackToTheDefaultAssetDomainWhenExtraLacksIt() {
        ExactEvmClientScheme scheme =
                new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0), CLOCK, fixedBytes(NONCE));
        Map<String, Object> nonStringName = new HashMap<>();
        nonStringName.put("name", 5);
        nonStringName.put("version", null);

        List<Map<String, Object>> extras =
                Arrays.asList(null, Map.of(), Map.of("version", "2"), Map.of("name", "USDC"), nonStringName);

        // Base Sepolia USDC's table entry is {name: "USDC", version: "2"}, the domain cast signed under
        for (Map<String, Object> extra : extras) {
            Map<String, Object> payload = scheme.createPaymentPayload(baseSepolia(extra));

            assertEquals(BASE_SEPOLIA_SIGNATURE, payload.get("signature"), "extra " + extra);
        }
    }

    @Test
    void signsUnderTheTokenDomainOfTheRequirements() {
        ClientEvmSigner signer = delegatingSigner(ANVIL_KEY_0);
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(signer, CLOCK);

        scheme.createPaymentPayload(requirements(BASE, BASE_USDC, "1000", null));

        assertEquals(new TypedDataDomain("USD Coin", "2", BigInteger.valueOf(8453), BASE_USDC), signedDomain(signer));
    }

    @Test
    void prefersExtraNameAndVersionOverTheDefaultAsset() {
        ClientEvmSigner both = delegatingSigner(ANVIL_KEY_0);
        ClientEvmSigner nameOnly = delegatingSigner(ANVIL_KEY_0);

        new ExactEvmClientScheme(both, CLOCK)
                .createPaymentPayload(baseSepolia(Map.of("name", "Custom", "version", "9")));
        new ExactEvmClientScheme(nameOnly, CLOCK).createPaymentPayload(baseSepolia(Map.of("name", "Custom")));

        assertEquals(new TypedDataDomain("Custom", "9", BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC), signedDomain(both));
        assertEquals(new TypedDataDomain("Custom", "2", BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC),
                signedDomain(nameOnly));
    }

    @Test
    void signsCustomTokensWithTheDomainFromExtra() {
        ClientEvmSigner signer = delegatingSigner(ANVIL_KEY_0);

        new ExactEvmClientScheme(signer, CLOCK).createPaymentPayload(
                requirements(BASE_SEPOLIA, CUSTOM_TOKEN, "1", Map.of("name", "My Token", "version", "1")));

        assertEquals(new TypedDataDomain("My Token", "1", BASE_SEPOLIA_CHAIN_ID, CUSTOM_TOKEN), signedDomain(signer));
    }

    @Test
    void rejectsCustomTokensWithoutDomain() {
        ClientEvmSigner signer = delegatingSigner(ANVIL_KEY_0);
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(signer, CLOCK);

        PaymentException e = assertThrows(PaymentException.class, () -> scheme.createPaymentPayload(
                requirements(BASE_SEPOLIA, CUSTOM_TOKEN, "1", Map.of("name", "My Token"))));

        assertEquals(ExactEvmErrors.MISSING_EIP712_DOMAIN, e.reason());
        verify(signer, never()).signTypedData(any(), anyList(), anyString(), anyMap());
    }

    @Test
    void setsTheValidityWindowFromTheInjectedClock() {
        Clock clock = Clock.fixed(Instant.ofEpochSecond(1_700_000_000L), ZoneOffset.UTC);
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0), clock);
        PaymentRequirements requirements =
                new PaymentRequirements("exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC, "1000", ANVIL_ADDRESS_1, 60, null);

        Eip3009Authorization authorization =
                ExactEvmPayload.fromMap(scheme.createPaymentPayload(requirements)).authorization();

        assertEquals("0", authorization.validAfter());
        assertEquals("1700000060", authorization.validBefore());
    }

    @Test
    void fillsTheAuthorizationFromSignerAndRequirements() {
        String lowerCasePayTo = ANVIL_ADDRESS_0.toLowerCase(Locale.ROOT);
        PaymentRequirements requirements =
                new PaymentRequirements("exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC, "0001000", lowerCasePayTo, 300, null);

        Eip3009Authorization authorization = ExactEvmPayload.fromMap(
                new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_1), CLOCK)
                        .createPaymentPayload(requirements)).authorization();

        assertEquals(ANVIL_ADDRESS_1, authorization.from());
        // payTo verbatim, value in canonical decimal form
        assertEquals(lowerCasePayTo, authorization.to());
        assertEquals("1000", authorization.value());
    }

    @Test
    void producesSignaturesThatRecoverToTheSignerAfterAJsonRoundTrip() throws IOException {
        PrivateKeyEvmSigner signer = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_1);
        PaymentRequirements requirements = baseSepolia(Map.of("name", "USDC", "version", "2"));
        Map<String, Object> inner = new ExactEvmClientScheme(signer).createPaymentPayload(requirements);

        String wire = Json.write(new PaymentPayload(X402.PROTOCOL_VERSION, inner, requirements, null, null));
        ExactEvmPayload payload = ExactEvmPayload.fromMap(Json.read(wire, PaymentPayload.class).payload());
        byte[] digest = payload.authorization().digest(
                new TypedDataDomain("USDC", "2", BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC));

        assertEquals(signer.address(), Secp256k1.recoverAddress(digest, Hex.decode(payload.signature())));
        assertEquals(65, Hex.decode(payload.signature()).length);
    }

    @Test
    void paysRequirementsBuiltByTheServerScheme() {
        ExactEvmServerScheme server = new ExactEvmServerScheme();
        AssetAmount price = server.parsePrice(Price.money("$0.001"), BASE_SEPOLIA);
        PaymentRequirements requirements = server.enhancePaymentRequirements(new PaymentRequirements(
                "exact", BASE_SEPOLIA, price.asset(), price.amount(), ANVIL_ADDRESS_1, 300, price.extra()), null);
        PrivateKeyEvmSigner signer = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0);

        ExactEvmPayload payload =
                ExactEvmPayload.fromMap(new ExactEvmClientScheme(signer).createPaymentPayload(requirements));

        // The facilitator rebuilds the domain from the requirements alone
        TypedDataDomain domain = new TypedDataDomain((String) requirements.extra().get("name"),
                (String) requirements.extra().get("version"), BASE_SEPOLIA_CHAIN_ID, requirements.asset());
        byte[] digest = payload.authorization().digest(domain);
        assertEquals(signer.address(), Secp256k1.recoverAddress(digest, Hex.decode(payload.signature())));
        assertTrue(EvmAddress.equalsIgnoreCase(requirements.payTo(), payload.authorization().to()));
        assertEquals(requirements.amount(), payload.authorization().value());
    }

    @Test
    void usesAFreshRandomNonceForEveryPayment() {
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0), CLOCK);
        Set<String> nonces = new HashSet<>();

        for (int i = 0; i < 50; i++) {
            String nonce = ExactEvmPayload.fromMap(scheme.createPaymentPayload(baseSepolia(null)))
                    .authorization().nonce();
            assertTrue(NONCE_FORMAT.matcher(nonce).matches(), nonce);
            nonces.add(nonce);
        }

        assertEquals(50, nonces.size());
    }

    @Test
    void isSafeToShareBetweenThreads() throws Exception {
        PrivateKeyEvmSigner signer = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0);
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(signer);
        TypedDataDomain domain = new TypedDataDomain("USDC", "2", BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC);
        Callable<ExactEvmPayload> pay =
                () -> ExactEvmPayload.fromMap(scheme.createPaymentPayload(baseSepolia(null)));
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            List<Future<ExactEvmPayload>> results = new ArrayList<>();
            for (int i = 0; i < 16; i++) {
                results.add(pool.submit(pay));
            }
            Set<String> nonces = new HashSet<>();
            for (Future<ExactEvmPayload> result : results) {
                ExactEvmPayload payload = result.get();
                byte[] digest = payload.authorization().digest(domain);
                assertEquals(signer.address(), Secp256k1.recoverAddress(digest, Hex.decode(payload.signature())));
                nonces.add(payload.authorization().nonce());
            }
            assertEquals(16, nonces.size());
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void acceptsTheEip3009TransferMethodSpelledOutOrEmpty() {
        ExactEvmClientScheme scheme =
                new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0), CLOCK, fixedBytes(NONCE));

        assertTrue(scheme.supports(baseSepolia(Map.of())));
        for (String method : List.of("eip3009", "")) {
            assertTrue(scheme.supports(baseSepolia(Map.of("assetTransferMethod", method))), method);
            Map<String, Object> payload =
                    scheme.createPaymentPayload(baseSepolia(Map.of("assetTransferMethod", method)));

            assertEquals(BASE_SEPOLIA_SIGNATURE, payload.get("signature"), method);
        }
    }

    @Test
    void refusesOtherTransferMethodsBeforeSigning() {
        ClientEvmSigner signer = delegatingSigner(ANVIL_KEY_0);
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(signer, CLOCK);

        for (Object method : List.of("permit2", "permit3", "EIP3009", 1)) {
            assertFalse(scheme.supports(baseSepolia(Map.of("assetTransferMethod", method))), String.valueOf(method));
            PaymentException e = assertThrows(PaymentException.class,
                    () -> scheme.createPaymentPayload(baseSepolia(Map.of("assetTransferMethod", method))));

            assertEquals(ExactEvmClientScheme.UNSUPPORTED_ASSET_TRANSFER_METHOD, e.reason());
            assertTrue(e.getMessage().contains(String.valueOf(method)), e.getMessage());
        }
        verify(signer, never()).signTypedData(any(), anyList(), anyString(), anyMap());
    }

    @Test
    void rejectsAmountsThatAreNotAtomicUnits() {
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0), CLOCK);
        String aboveUint256 = BigInteger.TWO.pow(256).toString();

        for (String amount : Arrays.asList("1.5", "0.001", "abc", "-1", "+1", " 1", "1e6", "0x10", "", null,
                aboveUint256)) {
            PaymentException e = assertThrows(PaymentException.class,
                    () -> scheme.createPaymentPayload(requirements(BASE_SEPOLIA, BASE_SEPOLIA_USDC, amount, null)));

            assertEquals(ExactEvmErrors.CLIENT_INVALID_AMOUNT, e.reason(), "amount " + amount);
        }
    }

    @Test
    void rejectsNetworksWithoutAnEvmChainId() {
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0), CLOCK);

        for (String network : Arrays.asList("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:abc", "eip155:0",
                "base-sepolia", null)) {
            PaymentException e = assertThrows(PaymentException.class,
                    () -> scheme.createPaymentPayload(requirements(network, BASE_SEPOLIA_USDC, "1000", null)));

            assertEquals(ExactEvmErrors.FAILED_TO_GET_NETWORK_CONFIG, e.reason(), "network " + network);
        }
    }

    @Test
    void rejectsAssetsAndRecipientsThatAreNotAddresses() {
        ClientEvmSigner signer = delegatingSigner(ANVIL_KEY_0);
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(signer, CLOCK);
        List<PaymentRequirements> malformed = List.of(
                requirements(BASE_SEPOLIA, "USDC", "1000", null),
                requirements(BASE_SEPOLIA, "", "1000", null),
                new PaymentRequirements("exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC, "1000", "0x1234", 300, null),
                new PaymentRequirements("exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC, "1000", null, 300, null));

        for (PaymentRequirements requirements : malformed) {
            PaymentException e = assertThrows(PaymentException.class, () -> scheme.createPaymentPayload(requirements));

            assertEquals(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION, e.reason());
            assertTrue(e.getMessage().contains("is not an EVM address"), e.getMessage());
        }
        verify(signer, never()).signTypedData(any(), anyList(), anyString(), anyMap());
    }

    @Test
    void rejectsNegativeTimeouts() {
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0), CLOCK);
        PaymentRequirements requirements =
                new PaymentRequirements("exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC, "1000", ANVIL_ADDRESS_1, -1, null);

        PaymentException e = assertThrows(PaymentException.class, () -> scheme.createPaymentPayload(requirements));

        assertEquals(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION, e.reason());
    }

    @Test
    void wrapsSignerFailures() {
        ClientEvmSigner signer = mock(ClientEvmSigner.class);
        UncheckedIOException outage = new UncheckedIOException(new IOException("KMS unreachable"));
        when(signer.address()).thenReturn(ANVIL_ADDRESS_0);
        when(signer.signTypedData(any(), anyList(), anyString(), anyMap())).thenThrow(outage);

        PaymentException e = assertThrows(PaymentException.class,
                () -> new ExactEvmClientScheme(signer, CLOCK).createPaymentPayload(baseSepolia(null)));

        assertEquals(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION, e.reason());
        assertSame(outage, e.getCause());
    }

    @Test
    void wrapsSignerAddressFailures() {
        ClientEvmSigner failing = mock(ClientEvmSigner.class);
        when(failing.address()).thenThrow(new IllegalStateException("locked"));
        ClientEvmSigner malformed = mock(ClientEvmSigner.class);
        when(malformed.address()).thenReturn("not an address");

        PaymentException failed = assertThrows(PaymentException.class,
                () -> new ExactEvmClientScheme(failing, CLOCK).createPaymentPayload(baseSepolia(null)));
        PaymentException invalid = assertThrows(PaymentException.class,
                () -> new ExactEvmClientScheme(malformed, CLOCK).createPaymentPayload(baseSepolia(null)));

        assertEquals(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION, failed.reason());
        assertEquals(IllegalStateException.class, failed.getCause().getClass());
        assertEquals(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION, invalid.reason());
        verify(malformed, never()).signTypedData(any(), anyList(), anyString(), anyMap());
    }

    @Test
    void rejectsSignaturesThatBreakTheSignerContract() {
        byte[] valid = Hex.decode(BASE_SEPOLIA_SIGNATURE);
        byte[] rawRecoveryId = valid.clone();
        rawRecoveryId[64] = (byte) (valid[64] - 27);
        // The same signature with s flipped to n - s and v toggled: valid ECDSA, but malleable (EIP-2)
        byte[] highS = valid.clone();
        BigInteger s = new BigInteger(1, Arrays.copyOfRange(valid, 32, 64));
        System.arraycopy(Uint256.toBytes(Secp256k1.CURVE_ORDER.subtract(s)), 0, highS, 32, 32);
        highS[64] = (byte) (valid[64] == 27 ? 28 : 27);

        for (byte[] signature : Arrays.asList(null, new byte[0], Arrays.copyOf(valid, 64), new byte[65],
                rawRecoveryId, highS)) {
            ClientEvmSigner signer = mock(ClientEvmSigner.class);
            when(signer.address()).thenReturn(ANVIL_ADDRESS_0);
            when(signer.signTypedData(any(), anyList(), anyString(), anyMap())).thenReturn(signature);

            PaymentException e = assertThrows(PaymentException.class,
                    () -> new ExactEvmClientScheme(signer, CLOCK).createPaymentPayload(baseSepolia(null)));

            assertEquals(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION, e.reason());
            assertFalse(e.getMessage().contains(BASE_SEPOLIA_SIGNATURE.substring(2, 20)), e.getMessage());
        }
    }

    @Test
    void passesTheTransferWithAuthorizationTypeAndMessageToTheSigner() {
        ClientEvmSigner signer = delegatingSigner(ANVIL_KEY_0);
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> message = ArgumentCaptor.forClass(Map.class);

        Map<String, Object> payload = new ExactEvmClientScheme(signer, CLOCK, fixedBytes(NONCE))
                .createPaymentPayload(baseSepolia(null));

        verify(signer).signTypedData(any(), eq(EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS),
                eq(EvmConstants.TRANSFER_WITH_AUTHORIZATION), message.capture());
        assertEquals(payload.get("authorization"), message.getValue());
    }

    @Test
    void reportsDecimalsOfDefaultAssets() {
        ExactEvmClientScheme scheme = new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0));

        assertEquals(OptionalInt.of(6), scheme.defaultAssetDecimals(BASE_SEPOLIA_USDC, BASE_SEPOLIA));
        assertEquals(OptionalInt.of(6),
                scheme.defaultAssetDecimals(BASE_SEPOLIA_USDC.toLowerCase(Locale.ROOT), BASE_SEPOLIA));
        // MegaUSD is a Permit2 token; its decimals are reported all the same
        assertEquals(OptionalInt.of(18),
                scheme.defaultAssetDecimals("0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7", "eip155:4326"));
        assertEquals(OptionalInt.empty(), scheme.defaultAssetDecimals(CUSTOM_TOKEN, BASE_SEPOLIA));
        assertEquals(OptionalInt.empty(), scheme.defaultAssetDecimals(BASE_SEPOLIA_USDC, BASE));
        assertEquals(OptionalInt.empty(), scheme.defaultAssetDecimals(null, BASE_SEPOLIA));
        assertEquals(OptionalInt.empty(), scheme.defaultAssetDecimals(BASE_SEPOLIA_USDC, null));
    }

    @Test
    void identifiesAsTheExactScheme() {
        assertEquals("exact", new ExactEvmClientScheme(PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0)).scheme());
    }

    private static PaymentRequirements baseSepolia(Map<String, Object> extra) {
        return requirements(BASE_SEPOLIA, BASE_SEPOLIA_USDC, "1000", extra);
    }

    private static PaymentRequirements requirements(
            String network, String asset, String amount, Map<String, Object> extra) {
        return new PaymentRequirements(
                "exact", network, asset, amount, ANVIL_ADDRESS_1, MAX_TIMEOUT_SECONDS, extra);
    }

    /** A mock that signs with a real key, so calls can be verified and captured. */
    private static ClientEvmSigner delegatingSigner(String privateKey) {
        return mock(ClientEvmSigner.class, AdditionalAnswers.delegatesTo(PrivateKeyEvmSigner.fromHex(privateKey)));
    }

    private static TypedDataDomain signedDomain(ClientEvmSigner signer) {
        ArgumentCaptor<TypedDataDomain> domain = ArgumentCaptor.forClass(TypedDataDomain.class);
        verify(signer).signTypedData(domain.capture(), anyList(), anyString(), anyMap());
        return domain.getValue();
    }

    /** Replays fixed bytes as the nonce, so a payment reproduces a known signature. */
    private static RandomGenerator fixedBytes(String hex) {
        byte[] bytes = Hex.decode(hex);
        return new RandomGenerator() {
            @Override
            public long nextLong() {
                throw new UnsupportedOperationException("only nextBytes is used for nonces");
            }

            @Override
            public void nextBytes(byte[] out) {
                System.arraycopy(bytes, 0, out, 0, out.length);
            }
        };
    }
}
