package org.x402.mechanisms.evm.exact;

import org.junit.jupiter.api.Test;
import org.x402.types.PaymentPayload;
import org.x402.util.Json;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_SIGNATURE;
import static org.x402.mechanisms.evm.CastVectors.NONCE;
import static org.x402.mechanisms.evm.CastVectors.VALID_BEFORE;
import static org.x402.mechanisms.evm.exact.Eip3009AuthorizationTest.AUTHORIZATION;

class ExactEvmPayloadTest {

    private static final String WIRE_PAYLOAD = "{\"signature\":\"" + BASE_SEPOLIA_SIGNATURE + "\","
            + "\"authorization\":{\"from\":\"" + ANVIL_ADDRESS_0 + "\",\"to\":\"" + ANVIL_ADDRESS_1 + "\","
            + "\"value\":\"1000\",\"validAfter\":\"0\",\"validBefore\":\"" + VALID_BEFORE + "\","
            + "\"nonce\":\"" + NONCE + "\"}}";

    @Test
    void serializesToTheSpecWireShape() {
        ExactEvmPayload payload = new ExactEvmPayload(BASE_SEPOLIA_SIGNATURE, AUTHORIZATION);

        assertEquals(WIRE_PAYLOAD, Json.write(payload.toMap()));
    }

    @Test
    void parsesThePayloadOfADecodedPaymentPayload() throws IOException {
        String json = "{\"x402Version\":2,\"payload\":" + WIRE_PAYLOAD + "}";
        PaymentPayload paymentPayload = Json.read(json, PaymentPayload.class);

        ExactEvmPayload payload = ExactEvmPayload.fromMap(paymentPayload.payload());

        assertEquals(new ExactEvmPayload(BASE_SEPOLIA_SIGNATURE, AUTHORIZATION), payload);
        assertTrue(payload.hasSignature());
    }

    @Test
    void treatsAbsentOrEmptySignatureAsMissingAndOmitsIt() {
        Map<String, Object> withoutSignature = Map.of("authorization", AUTHORIZATION.toMap());
        ExactEvmPayload absent = ExactEvmPayload.fromMap(withoutSignature);
        ExactEvmPayload empty = new ExactEvmPayload("", AUTHORIZATION);

        assertFalse(absent.hasSignature());
        assertFalse(empty.hasSignature());
        assertEquals(withoutSignature, absent.toMap());
        assertEquals(withoutSignature, empty.toMap());
    }

    @Test
    void keepsAMalformedSignatureForTheFacilitatorToReport() {
        ExactEvmPayload payload = ExactEvmPayload.fromMap(Map.of("signature", "0xnot-hex",
                "authorization", AUTHORIZATION.toMap()));

        assertEquals("0xnot-hex", payload.signature());
    }

    @Test
    void rejectsMalformedShapes() {
        assertShapeError("authorization is missing", Map.of("signature", BASE_SEPOLIA_SIGNATURE));
        assertShapeError("authorization must be an object", Map.of("authorization", "nope"));
        assertShapeError("signature must be a string", Map.of("signature", 65, "authorization",
                AUTHORIZATION.toMap()));
        Map<String, Object> badAuthorization = new LinkedHashMap<>(AUTHORIZATION.toMap());
        badAuthorization.put("to", "0x1234");
        assertShapeError("authorization.to is not an EVM address", Map.of("authorization", badAuthorization));
    }

    @Test
    void ignoresNonStringKeysInsideAuthorization() {
        Map<Object, Object> authorization = new LinkedHashMap<>(AUTHORIZATION.toMap());
        authorization.put(1, "ignored");

        assertEquals(AUTHORIZATION, ExactEvmPayload.fromMap(Map.of("authorization", authorization)).authorization());
    }

    @Test
    void toStringRedactsTheSignature() {
        String text = new ExactEvmPayload(BASE_SEPOLIA_SIGNATURE, AUTHORIZATION).toString();

        assertFalse(text.contains(BASE_SEPOLIA_SIGNATURE.substring(2, 20)), text);
        assertTrue(text.startsWith("ExactEvmPayload[signature=<present>, authorization="), text);
        assertTrue(new ExactEvmPayload(null, AUTHORIZATION).toString().contains("signature=<absent>"));
    }

    private static void assertShapeError(String message, Map<String, ?> map) {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> ExactEvmPayload.fromMap(map));
        assertEquals(message, e.getMessage());
    }
}
