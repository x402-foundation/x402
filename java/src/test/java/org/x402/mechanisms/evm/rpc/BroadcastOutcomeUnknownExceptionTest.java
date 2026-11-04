package org.x402.mechanisms.evm.rpc;

import org.junit.jupiter.api.Test;

import java.io.IOException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

class BroadcastOutcomeUnknownExceptionTest {

    @Test
    void carriesTheNormalizedHashMessageAndCause() {
        IOException cause = new IOException("eth_sendRawTransaction: no response within PT30S");

        BroadcastOutcomeUnknownException e =
                new BroadcastOutcomeUnknownException("0x" + "AB".repeat(32), "outcome unknown", cause);

        assertEquals("0x" + "ab".repeat(32), e.transactionHash());
        assertEquals("outcome unknown", e.getMessage());
        assertSame(cause, e.getCause());
    }

    @Test
    void rejectsSomethingThatIsNotATransactionHash() {
        assertThrows(IllegalArgumentException.class,
                () -> new BroadcastOutcomeUnknownException("0x1234", "outcome unknown", null));
    }
}
