package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Keccak;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.Secp256k1;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_CHAIN_ID;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.MINIMAL_TX;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.SETTLEMENT_TX;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.SETTLEMENT_TX_HASH;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TWA_CALLDATA;

class Eip1559TransactionTest {

    private static final BigInteger GWEI = BigInteger.valueOf(1_000_000_000L);

    @Test
    void signsTheSettlementTransactionLikeCastMktx() {
        Eip1559Transaction transaction = new Eip1559Transaction(BASE_SEPOLIA_CHAIN_ID, BigInteger.valueOf(7), GWEI,
                BigInteger.valueOf(2_000_000_100L), BigInteger.valueOf(96_000), BASE_SEPOLIA_USDC, BigInteger.ZERO,
                Hex.decode(TWA_CALLDATA));

        byte[] raw = sign(transaction, ANVIL_KEY_0);

        assertEquals(SETTLEMENT_TX, Hex.encode(raw));
        assertEquals(SETTLEMENT_TX_HASH, Hex.encode(Keccak.keccak256(raw)));
    }

    @Test
    void encodesZeroFieldsAndEmptyDataLikeCastMktx() {
        Eip1559Transaction transaction = new Eip1559Transaction(BigInteger.ONE, BigInteger.ZERO, BigInteger.ZERO,
                BigInteger.ONE, BigInteger.valueOf(21_000), ANVIL_ADDRESS_0, BigInteger.ZERO, new byte[0]);

        assertEquals(MINIMAL_TX, Hex.encode(sign(transaction, ANVIL_KEY_1)));
    }

    @Test
    void signingHashRecoversToTheSender() {
        Eip1559Transaction transaction = new Eip1559Transaction(BASE_SEPOLIA_CHAIN_ID, BigInteger.TEN, GWEI, GWEI,
                BigInteger.valueOf(50_000), ANVIL_ADDRESS_1, BigInteger.valueOf(5), Hex.decode("0x1234"));
        PrivateKeyEvmSigner key = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0);

        Secp256k1.Signature signature = key.signDigest(transaction.signingHash());

        assertEquals(ANVIL_ADDRESS_0, Secp256k1.recoverAddress(transaction.signingHash(), signature));
    }

    @Test
    void copiesTheCalldata() {
        byte[] data = Hex.decode(TWA_CALLDATA);
        Eip1559Transaction transaction = new Eip1559Transaction(BASE_SEPOLIA_CHAIN_ID, BigInteger.valueOf(7), GWEI,
                BigInteger.valueOf(2_000_000_100L), BigInteger.valueOf(96_000), BASE_SEPOLIA_USDC, BigInteger.ZERO,
                data);

        data[0] = 0;

        assertEquals(SETTLEMENT_TX, Hex.encode(sign(transaction, ANVIL_KEY_0)));
    }

    @Test
    void rejectsOutOfRangeFields() {
        BigInteger maxUint64 = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);
        BigInteger tooBig = BigInteger.ONE.shiftLeft(256);

        assertThrows(IllegalArgumentException.class, () -> transaction(BigInteger.ZERO, BigInteger.ZERO, GWEI, GWEI,
                BigInteger.ONE, ANVIL_ADDRESS_0));
        assertThrows(IllegalArgumentException.class, () -> transaction(tooBig, BigInteger.ZERO, GWEI, GWEI,
                BigInteger.ONE, ANVIL_ADDRESS_0));
        assertThrows(IllegalArgumentException.class, () -> transaction(BigInteger.ONE, maxUint64.add(BigInteger.ONE),
                GWEI, GWEI, BigInteger.ONE, ANVIL_ADDRESS_0));
        assertThrows(IllegalArgumentException.class, () -> transaction(BigInteger.ONE, BigInteger.ONE.negate(),
                GWEI, GWEI, BigInteger.ONE, ANVIL_ADDRESS_0));
        assertThrows(IllegalArgumentException.class, () -> transaction(BigInteger.ONE, BigInteger.ZERO, GWEI, GWEI,
                BigInteger.ZERO, ANVIL_ADDRESS_0));
        assertThrows(IllegalArgumentException.class, () -> transaction(BigInteger.ONE, BigInteger.ZERO, tooBig,
                tooBig, BigInteger.ONE, ANVIL_ADDRESS_0));
        assertThrows(IllegalArgumentException.class, () -> transaction(BigInteger.ONE, BigInteger.ZERO, GWEI,
                BigInteger.ONE, BigInteger.ONE, ANVIL_ADDRESS_0));
        assertThrows(IllegalArgumentException.class, () -> transaction(BigInteger.ONE, BigInteger.ZERO, GWEI, GWEI,
                BigInteger.ONE, "0x1234"));
        assertThrows(IllegalArgumentException.class, () -> new Eip1559Transaction(BigInteger.ONE, BigInteger.ZERO,
                GWEI, GWEI, BigInteger.ONE, ANVIL_ADDRESS_0, BigInteger.ONE.negate(), new byte[0]));
    }

    @Test
    void acceptsTheLargestNonceAndGasLimit() {
        BigInteger maxUint64 = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);

        Eip1559Transaction transaction = transaction(BigInteger.ONE, maxUint64, GWEI, GWEI, maxUint64, ANVIL_ADDRESS_0);

        assertEquals(32, transaction.signingHash().length);
    }

    private static Eip1559Transaction transaction(BigInteger chainId, BigInteger nonce, BigInteger tip,
            BigInteger maxFee, BigInteger gasLimit, String to) {
        return new Eip1559Transaction(chainId, nonce, tip, maxFee, gasLimit, to, BigInteger.ZERO, new byte[0]);
    }

    private static byte[] sign(Eip1559Transaction transaction, String key) {
        return transaction.encodeSigned(PrivateKeyEvmSigner.fromHex(key).signDigest(transaction.signingHash()));
    }
}
