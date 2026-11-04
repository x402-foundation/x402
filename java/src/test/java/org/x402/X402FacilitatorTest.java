package org.x402;

import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.ResourceInfo;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedKind;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;
import org.x402.util.Json;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class X402FacilitatorTest {

    // Values from the facilitator API examples in specs/x402-specification-v2.md section 7.
    private static final String BASE_SEPOLIA = "eip155:84532";
    private static final String USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
    private static final String PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
    private static final String TRANSACTION = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    private static final String FACILITATOR_SIGNER = "0x1234567890abcdef1234567890abcdef12345678";

    @Test
    void verifyDelegatesToTheSchemeRegisteredForTheNetwork() throws Exception {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), exact).build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);
        PaymentPayload payload = payload(2, requirements);

        VerifyResponse response = facilitator.verify(payload, requirements);

        assertTrue(response.isValid());
        assertEquals(PAYER, response.payer());
        assertEquals(List.of(payload), exact.verified);
        assertEquals(List.of(requirements), exact.verifiedRequirements);
        assertTrue(exact.settled.isEmpty());
    }

    @Test
    void settleDelegatesToTheSchemeRegisteredForTheNetwork() throws Exception {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), exact).build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);
        PaymentPayload payload = payload(2, requirements);

        SettleResponse response = facilitator.settle(payload, requirements);

        assertSame(exact.settleResponse, response);
        assertEquals(List.of(payload), exact.settled);
        assertTrue(exact.verified.isEmpty());
    }

    @Test
    void schemeVerdictsAreReturnedUnchanged() throws Exception {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        exact.verifyResponse = VerifyResponse.invalid("invalid_exact_evm_signature", "bad signature", PAYER);
        exact.settleResponse = SettleResponse.failure("invalid_exact_evm_transaction_failed", null, PAYER,
                TRANSACTION, BASE_SEPOLIA);
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), exact).build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);

        assertSame(exact.verifyResponse, facilitator.verify(payload(2, requirements), requirements));
        assertSame(exact.settleResponse, facilitator.settle(payload(2, requirements), requirements));
    }

    @Test
    void rejectsPayloadsOfAnotherProtocolVersion() throws Exception {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), exact).build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);
        PaymentPayload v1 = payload(1, requirements);

        VerifyResponse verify = facilitator.verify(v1, requirements);
        SettleResponse settle = facilitator.settle(v1, requirements);

        assertInvalid(verify, "invalid_version");
        assertTrue(verify.invalidMessage().contains("unsupported x402Version 1"), verify.invalidMessage());
        assertFailed(settle, "invalid_version", BASE_SEPOLIA);
        assertTrue(exact.verified.isEmpty());
        assertTrue(exact.settled.isEmpty());
    }

    @Test
    void rejectsPayloadsWithoutAcceptedRequirements() throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(BASE_SEPOLIA), new FakeScheme("exact", "eip155:*"))
                .build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);
        PaymentPayload payload = new PaymentPayload(2, Map.of(), null, null, null);

        assertInvalid(facilitator.verify(payload, requirements), "invalid_v2_payload");
        assertFailed(facilitator.settle(payload, requirements), "invalid_v2_payload", BASE_SEPOLIA);
    }

    @Test
    void rejectsRequirementsWithoutSchemeOrNetwork() throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(BASE_SEPOLIA), new FakeScheme("exact", "eip155:*"))
                .build();
        PaymentRequirements noScheme = requirements(null, BASE_SEPOLIA);
        PaymentRequirements noNetwork = requirements("exact", null);

        assertInvalid(facilitator.verify(payload(2, noScheme), noScheme), "invalid_v2_requirements");
        assertInvalid(facilitator.verify(payload(2, noNetwork), noNetwork), "invalid_v2_requirements");
        assertFailed(facilitator.settle(payload(2, noNetwork), noNetwork), "invalid_v2_requirements", "");
    }

    @Test
    void leavesAnAcceptedSchemeThatDiffersFromTheRequirementsToTheScheme() throws Exception {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        exact.verifyResponse = VerifyResponse.invalid("invalid_exact_evm_scheme", "invalid scheme: upto", null);
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), exact).build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);
        PaymentPayload payload = payload(2, requirements("upto", BASE_SEPOLIA));

        assertSame(exact.verifyResponse, facilitator.verify(payload, requirements));
        assertSame(exact.settleResponse, facilitator.settle(payload, requirements));
        assertEquals(List.of(requirements), exact.verifiedRequirements);
        assertEquals(List.of(payload), exact.settled);
    }

    @Test
    void routesByTheRequirementsNetworkWhenAcceptedNamesAnother() throws Exception {
        FakeScheme baseSepolia = new FakeScheme("exact", "eip155:*");
        FakeScheme base = new FakeScheme("exact", "eip155:*");
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(BASE_SEPOLIA), baseSepolia)
                .register(List.of("eip155:8453"), base)
                .build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);
        PaymentPayload payload = payload(2, requirements("exact", "eip155:8453"));

        facilitator.verify(payload, requirements);

        assertEquals(List.of(payload), baseSepolia.verified);
        assertTrue(base.verified.isEmpty());
    }

    @Test
    void reportsNoFacilitatorForAnUnregisteredNetwork() throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of("eip155:8453"), new FakeScheme("exact", "eip155:*"))
                .build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);

        VerifyResponse verify = facilitator.verify(payload(2, requirements), requirements);
        SettleResponse settle = facilitator.settle(payload(2, requirements), requirements);

        assertInvalid(verify, "no_facilitator_for_network");
        assertEquals("no facilitator for scheme \"exact\" on network \"eip155:84532\"; registered: exact@eip155:8453",
                verify.invalidMessage());
        assertFailed(settle, "no_facilitator_for_network", BASE_SEPOLIA);
        assertEquals(verify.invalidMessage(), settle.errorMessage());
    }

    @Test
    void reportsNoFacilitatorForAnUnregisteredScheme() throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(BASE_SEPOLIA), new FakeScheme("exact", "eip155:*"))
                .build();
        PaymentRequirements requirements = requirements("upto", BASE_SEPOLIA);

        assertInvalid(facilitator.verify(payload(2, requirements), requirements), "no_facilitator_for_network");
    }

    @Test
    void facilitatorWithoutRegistrationsSupportsNothing() throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder().build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);

        VerifyResponse verify = facilitator.verify(payload(2, requirements), requirements);

        assertInvalid(verify, "no_facilitator_for_network");
        assertTrue(verify.invalidMessage().endsWith("registered: (none)"), verify.invalidMessage());
        assertEquals(new SupportedResponse(List.of(), List.of(), Map.of()), facilitator.supported());
    }

    @Test
    void registeringSeveralNetworksOfANamespaceServesTheWholeNamespace() throws Exception {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of("stellar:testnet", "stellar:futurenet", "eip155:8453", "eip155:1"), exact)
                .build();

        assertTrue(verifyOn(facilitator, "stellar:pubnet").isValid());
        assertTrue(verifyOn(facilitator, "eip155:11155111").isValid());
        assertEquals(2, exact.verified.size());
    }

    @Test
    void registeringOneNetworkOfANamespaceMatchesOnlyThatNetwork() throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of("stellar:testnet", "stellar:futurenet", "eip155:8453"),
                        new FakeScheme("exact", "eip155:*"))
                .build();

        assertTrue(verifyOn(facilitator, "stellar:pubnet").isValid());
        assertTrue(verifyOn(facilitator, "eip155:8453").isValid());
        assertInvalid(verifyOn(facilitator, "eip155:11155111"), "no_facilitator_for_network");
        assertInvalid(verifyOn(facilitator, "solana:mainnet"), "no_facilitator_for_network");
    }

    @Test
    void explicitlyRegisteredNetworkTakesPrecedenceOverAnEarlierWildcard() throws Exception {
        FakeScheme wildcard = new FakeScheme("exact", "eip155:*");
        FakeScheme explicit = new FakeScheme("exact", "eip155:*");
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of("eip155:1", "eip155:8453"), wildcard)
                .register(List.of(BASE_SEPOLIA), explicit)
                .build();

        verifyOn(facilitator, BASE_SEPOLIA);
        verifyOn(facilitator, "eip155:10");

        assertEquals(1, explicit.verified.size());
        assertEquals(BASE_SEPOLIA, explicit.verifiedRequirements.get(0).network());
        assertEquals(1, wildcard.verified.size());
        assertEquals("eip155:10", wildcard.verifiedRequirements.get(0).network());
    }

    @Test
    void wildcardRequirementNetworksAreNeverRouted() throws Exception {
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of("eip155:1", "eip155:8453"), new FakeScheme("exact", "eip155:*"))
                .build();

        assertInvalid(verifyOn(facilitator, "eip155:*"), "no_facilitator_for_network");
    }

    @Test
    void routesBySchemeWhenSeveralSchemesShareANetwork() throws Exception {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        FakeScheme upto = new FakeScheme("upto", "eip155:*");
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(BASE_SEPOLIA), exact)
                .register(List.of(BASE_SEPOLIA), upto)
                .build();
        PaymentRequirements requirements = requirements("upto", BASE_SEPOLIA);

        facilitator.verify(payload(2, requirements), requirements);

        assertTrue(exact.verified.isEmpty());
        assertEquals(1, upto.verified.size());
    }

    @Test
    void supportedAdvertisesEachRegisteredNetworkOnceInRegistrationOrder() {
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of("stellar:testnet", "eip155:8453", "stellar:pubnet"),
                        new FakeScheme("exact", "eip155:*"))
                .build();

        List<String> networks = new ArrayList<>();
        for (SupportedKind kind : facilitator.supported().kinds()) {
            networks.add(kind.network());
        }

        assertEquals(List.of("stellar:testnet", "stellar:pubnet", "eip155:8453"), networks);
    }

    @Test
    void supportedListsKindsExtraAndSignersByFamily() {
        FakeScheme evm = new FakeScheme("exact", "eip155:*");
        evm.signers = List.of(FACILITATOR_SIGNER);
        FakeScheme svm = new FakeScheme("exact", "solana:*");
        svm.extra = Map.of("feePayer", "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5");
        svm.signers = List.of("CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5");
        FakeScheme upto = new FakeScheme("upto", "eip155:*");
        upto.extra = Map.of();
        upto.signers = List.of(FACILITATOR_SIGNER, "0x00000000000000000000000000000000000000aa");
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(BASE_SEPOLIA, "eip155:8453"), evm)
                .register(List.of("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), svm)
                .register(List.of(BASE_SEPOLIA), upto)
                .build();

        SupportedResponse supported = facilitator.supported();

        assertEquals(List.of(
                new SupportedKind(2, "exact", BASE_SEPOLIA, null),
                new SupportedKind(2, "exact", "eip155:8453", null),
                new SupportedKind(2, "exact", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", svm.extra),
                new SupportedKind(2, "upto", BASE_SEPOLIA, null)), supported.kinds());
        assertEquals(Map.of(
                "eip155:*", List.of(FACILITATOR_SIGNER, "0x00000000000000000000000000000000000000aa"),
                "solana:*", List.of("CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5")), supported.signers());
        assertEquals(List.of(), supported.extensions());
        assertEquals(List.of(BASE_SEPOLIA, "eip155:8453"), evm.extraQueries);
    }

    @Test
    void supportedSerializesToTheSpecifiedWireShape() throws IOException {
        FakeScheme evm = new FakeScheme("exact", "eip155:*");
        evm.signers = List.of(FACILITATOR_SIGNER);
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(BASE_SEPOLIA, "eip155:8453"), evm)
                .build();

        String json = Json.write(facilitator.supported());

        assertEquals(Json.readTree("{\"kinds\":["
                + "{\"x402Version\":2,\"scheme\":\"exact\",\"network\":\"eip155:84532\"},"
                + "{\"x402Version\":2,\"scheme\":\"exact\",\"network\":\"eip155:8453\"}],"
                + "\"extensions\":[],"
                + "\"signers\":{\"eip155:*\":[\"0x1234567890abcdef1234567890abcdef12345678\"]}}"),
                Json.readTree(json));
    }

    @Test
    void supportedToleratesSchemesThatReportNoSigners() {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        exact.signers = null;
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), exact).build();

        assertEquals(Map.of("eip155:*", List.of()), facilitator.supported().signers());
    }

    @Test
    void schemeExceptionsPropagate() {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        exact.failure = new IOException("rpc unreachable");
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), exact).build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);

        assertSame(exact.failure,
                assertThrows(IOException.class, () -> facilitator.verify(payload(2, requirements), requirements)));
        assertSame(exact.failure,
                assertThrows(IOException.class, () -> facilitator.settle(payload(2, requirements), requirements)));
    }

    @Test
    void nullSchemeResultsAreRejected() {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        exact.verifyResponse = null;
        exact.settleResponse = null;
        X402Facilitator facilitator = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), exact).build();
        PaymentRequirements requirements = requirements("exact", BASE_SEPOLIA);

        assertThrows(IllegalStateException.class, () -> facilitator.verify(payload(2, requirements), requirements));
        assertThrows(IllegalStateException.class, () -> facilitator.settle(payload(2, requirements), requirements));
    }

    @Test
    void registerRejectsInvalidNetworks() {
        FakeScheme exact = new FakeScheme("exact", "eip155:*");
        X402Facilitator.Builder builder = X402Facilitator.builder();

        assertThrows(IllegalArgumentException.class, () -> builder.register(List.of(), exact));
        assertThrows(IllegalArgumentException.class, () -> builder.register(List.of("eip155:*"), exact));
        assertThrows(IllegalArgumentException.class, () -> builder.register(List.of("base-sepolia"), exact));
        assertTrue(builder.build().supported().kinds().isEmpty());
    }

    @Test
    void registerRejectsSchemesWithoutAName() {
        X402Facilitator.Builder builder = X402Facilitator.builder();

        assertThrows(IllegalArgumentException.class,
                () -> builder.register(List.of(BASE_SEPOLIA), new FakeScheme("", "eip155:*")));
        assertThrows(NullPointerException.class,
                () -> builder.register(List.of(BASE_SEPOLIA), new FakeScheme(null, "eip155:*")));
    }

    @Test
    void registerRejectsDuplicateSchemeAndNetwork() {
        FakeScheme first = new FakeScheme("exact", "eip155:*");
        FakeScheme second = new FakeScheme("exact", "eip155:*");
        X402Facilitator.Builder builder = X402Facilitator.builder().register(List.of(BASE_SEPOLIA), first);

        IllegalArgumentException across =
                assertThrows(IllegalArgumentException.class, () -> builder.register(List.of(BASE_SEPOLIA), second));
        IllegalArgumentException within = assertThrows(IllegalArgumentException.class,
                () -> builder.register(List.of("eip155:8453", "eip155:8453"), second));

        assertEquals("Scheme exact is already registered for network eip155:84532", across.getMessage());
        assertEquals("Scheme exact is already registered for network eip155:8453", within.getMessage());
        assertEquals(1, builder.build().supported().kinds().size());
    }

    @Test
    void builtFacilitatorIsUnaffectedByLaterRegistrations() {
        X402Facilitator.Builder builder = X402Facilitator.builder()
                .register(List.of(BASE_SEPOLIA), new FakeScheme("exact", "eip155:*"));
        X402Facilitator first = builder.build();

        builder.register(List.of("eip155:8453"), new FakeScheme("exact", "eip155:*"));

        assertEquals(1, first.supported().kinds().size());
        assertEquals(2, builder.build().supported().kinds().size());
    }

    private static VerifyResponse verifyOn(X402Facilitator facilitator, String network) throws Exception {
        PaymentRequirements requirements = requirements("exact", network);
        return facilitator.verify(payload(2, requirements), requirements);
    }

    private static PaymentRequirements requirements(String scheme, String network) {
        return new PaymentRequirements(scheme, network, USDC_BASE_SEPOLIA, "10000", PAY_TO, 60,
                Map.of("name", "USDC", "version", "2"));
    }

    private static PaymentPayload payload(int version, PaymentRequirements accepted) {
        return new PaymentPayload(version, Map.of("signature", "0x..."), accepted,
                ResourceInfo.of("https://api.example.com/premium-data", "Access to premium market data",
                        "application/json"),
                null);
    }

    private static void assertInvalid(VerifyResponse response, String reason) {
        assertFalse(response.isValid());
        assertEquals(reason, response.invalidReason());
        assertNull(response.payer());
    }

    private static void assertFailed(SettleResponse response, String reason, String network) {
        assertFalse(response.success());
        assertEquals(reason, response.errorReason());
        assertEquals("", response.transaction());
        assertEquals(network, response.network());
        assertNull(response.payer());
    }

    /** Scheme facilitator that records calls and returns configurable results. */
    private static final class FakeScheme implements SchemeNetworkFacilitator {

        private final String scheme;
        private final String family;
        private final List<PaymentPayload> verified = new ArrayList<>();
        private final List<PaymentRequirements> verifiedRequirements = new ArrayList<>();
        private final List<PaymentPayload> settled = new ArrayList<>();
        private final List<String> extraQueries = new ArrayList<>();
        private Map<String, Object> extra;
        private List<String> signers = List.of();
        private VerifyResponse verifyResponse = VerifyResponse.valid(PAYER);
        private SettleResponse settleResponse = SettleResponse.success(PAYER, TRANSACTION, BASE_SEPOLIA);
        private IOException failure;

        FakeScheme(String scheme, String family) {
            this.scheme = scheme;
            this.family = family;
        }

        @Override
        public String scheme() {
            return scheme;
        }

        @Override
        public String caipFamily() {
            return family;
        }

        @Override
        public Map<String, Object> extra(String network) {
            extraQueries.add(network);
            return extra;
        }

        @Override
        public List<String> signers(String network) {
            return signers;
        }

        @Override
        public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) throws IOException {
            if (failure != null) {
                throw failure;
            }
            verified.add(payload);
            verifiedRequirements.add(requirements);
            return verifyResponse;
        }

        @Override
        public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) throws IOException {
            if (failure != null) {
                throw failure;
            }
            settled.add(payload);
            return settleResponse;
        }
    }
}
