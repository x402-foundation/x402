package org.x402.mechanisms.evm.rpc;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.SETTLEMENT_TX_HASH;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TRANSFER_TOPIC;

class TransactionReceiptTest {

    @Test
    void copiesLogsAndTopics() {
        List<String> topics = new ArrayList<>(List.of(TRANSFER_TOPIC));
        List<TransactionReceipt.Log> logs = new ArrayList<>(List.of(new TransactionReceipt.Log(BASE_SEPOLIA_USDC,
                topics, "0x")));

        TransactionReceipt receipt = new TransactionReceipt(SETTLEMENT_TX_HASH, 1, true, logs);
        logs.clear();
        topics.clear();

        assertEquals(1, receipt.logs().size());
        assertEquals(List.of(TRANSFER_TOPIC), receipt.logs().get(0).topics());
        assertThrows(UnsupportedOperationException.class, () -> receipt.logs().clear());
    }

    @Test
    void allowsUnreportedLogs() {
        assertNull(new TransactionReceipt(SETTLEMENT_TX_HASH, 0, false, null).logs());
    }

    @Test
    void rejectsMalformedReceipts() {
        assertThrows(IllegalArgumentException.class, () -> new TransactionReceipt("0x1234", 1, true, List.of()));
        assertThrows(IllegalArgumentException.class,
                () -> new TransactionReceipt(SETTLEMENT_TX_HASH, -1, true, List.of()));
    }

    @Test
    void rejectsMalformedLogs() {
        assertThrows(IllegalArgumentException.class,
                () -> new TransactionReceipt.Log("0x1234", List.of(TRANSFER_TOPIC), "0x"));
        assertThrows(IllegalArgumentException.class,
                () -> new TransactionReceipt.Log(BASE_SEPOLIA_USDC, List.of("0x01"), "0x"));
        assertThrows(IllegalArgumentException.class,
                () -> new TransactionReceipt.Log(BASE_SEPOLIA_USDC, List.of(TRANSFER_TOPIC), "0x0"));
    }

    @Test
    void revertDataIsCopiedBothWays() {
        byte[] data = {1, 2, 3};
        ContractRevertException revert = new ContractRevertException("execution reverted", data);

        data[0] = 9;
        revert.revertData()[1] = 9;

        assertArrayEquals(new byte[] {1, 2, 3}, revert.revertData());
        assertEquals("execution reverted", revert.getMessage());
    }
}
