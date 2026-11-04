package org.x402.http;

import org.x402.SettleException;
import org.x402.VerifyException;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FacilitatorResponsesTest {

    @Test
    void excerptCollapsesWhitespaceAndControlCharacters() {
        assertEquals("line1 line2 end", FacilitatorResponses.excerpt(bytes("  line1\r\n\tline2\u0000end \n")));
    }

    @Test
    void excerptOfABlankBodyIsAPlaceholder() {
        assertEquals("<empty response>", FacilitatorResponses.excerpt(bytes("")));
        assertEquals("<empty response>", FacilitatorResponses.excerpt(bytes(" \r\n\t")));
    }

    @Test
    void excerptIsCutAtTheLimit() {
        String atLimit = "a".repeat(FacilitatorResponses.EXCERPT_LIMIT);
        String overLimit = "b".repeat(FacilitatorResponses.EXCERPT_LIMIT + 1);

        assertEquals(atLimit, FacilitatorResponses.excerpt(bytes(atLimit)));
        assertEquals("b".repeat(FacilitatorResponses.EXCERPT_LIMIT - 3) + "...",
                FacilitatorResponses.excerpt(bytes(overLimit)));
    }

    @Test
    void verifyRejectionRequiresATextualReason() {
        assertTrue(FacilitatorResponses.verifyRejection(bytes("{\"invalidReason\":42}")).isEmpty());
        assertTrue(FacilitatorResponses.verifyRejection(bytes("{\"invalidReason\":null}")).isEmpty());
        assertTrue(FacilitatorResponses.verifyRejection(bytes("not json")).isEmpty());
        assertTrue(FacilitatorResponses.verifyRejection(bytes("null")).isEmpty());
    }

    @Test
    void verifyRejectionIgnoresMistypedOptionalFields() {
        Optional<VerifyException> rejection =
                FacilitatorResponses.verifyRejection(bytes("{\"invalidReason\":\"invalid_scheme\",\"payer\":7}"));

        assertTrue(rejection.isPresent());
        assertEquals("invalid_scheme", rejection.get().reason());
        assertNull(rejection.get().payer());
        assertNull(rejection.get().invalidMessage());
    }

    @Test
    void settleRejectionDefaultsMissingNetworkAndTransactionToEmpty() {
        Optional<SettleException> rejection =
                FacilitatorResponses.settleRejection(400, bytes("{\"errorReason\":\"unsupported_scheme\"}"));

        assertTrue(rejection.isPresent());
        assertEquals("unsupported_scheme", rejection.get().reason());
        assertEquals("", rejection.get().network());
        assertEquals("", rejection.get().transaction());
        assertEquals("facilitator returned 400", rejection.get().errorMessage());
        assertTrue(FacilitatorResponses.settleRejection(400, bytes("{\"errorReason\":\"\"}")).isEmpty());
    }

    @Test
    void settleRejectionIgnoresAnEmptyErrorMessage() {
        Optional<SettleException> rejection = FacilitatorResponses.settleRejection(
                409, bytes("{\"errorReason\":\"invalid_transaction_state\",\"errorMessage\":\"\"}"));

        assertTrue(rejection.isPresent());
        assertEquals("facilitator returned 409", rejection.get().errorMessage());
    }

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }
}
