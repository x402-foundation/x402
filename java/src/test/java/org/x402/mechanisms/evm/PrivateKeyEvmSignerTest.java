package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_0;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_CHAIN_ID;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_SIGNATURE;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.CastVectors.HIGH_S_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.HIGH_S_DIGEST_SIGNATURE;
import static org.x402.mechanisms.evm.CastVectors.NONCE;
import static org.x402.mechanisms.evm.CastVectors.VALID_BEFORE;

class PrivateKeyEvmSignerTest {

    private static final TypedDataDomain DOMAIN =
            new TypedDataDomain("USDC", "2", BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC);

    @Test
    void derivesChecksummedAddressFromKeyWithOrWithoutPrefix() {
        assertEquals(ANVIL_ADDRESS_0, PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0).address());
        assertEquals(ANVIL_ADDRESS_0, PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0.substring(2)).address());
    }

    @Test
    void signsTypedDataLikeCast() {
        byte[] signature = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0).signTypedData(DOMAIN,
                EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS, EvmConstants.TRANSFER_WITH_AUTHORIZATION, message());

        assertEquals(BASE_SEPOLIA_SIGNATURE, Hex.encode(signature));
        assertEquals(65, signature.length);
        assertEquals(28, signature[64]);
    }

    @Test
    void signsDigestsLikeCastNoHash() {
        PrivateKeyEvmSigner signer = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0);

        assertEquals(BASE_SEPOLIA_SIGNATURE, Hex.encode(signer.signDigest(Hex.decode(BASE_SEPOLIA_DIGEST)).toBytes()));
        assertEquals(HIGH_S_DIGEST_SIGNATURE, Hex.encode(signer.signDigest(Hex.decode(HIGH_S_DIGEST)).toBytes()));
    }

    @Test
    void producesTheSameSignatureFromConcurrentThreads() throws Exception {
        PrivateKeyEvmSigner signer = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0);
        Callable<String> sign = () -> Hex.encode(signer.signTypedData(DOMAIN,
                EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS, EvmConstants.TRANSFER_WITH_AUTHORIZATION, message()));
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            List<Future<String>> results = new ArrayList<>();
            for (int i = 0; i < 16; i++) {
                results.add(pool.submit(sign));
            }
            for (Future<String> result : results) {
                assertEquals(BASE_SEPOLIA_SIGNATURE, result.get());
            }
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void toStringShowsAddressButNeverTheKey() {
        String text = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0).toString();

        assertEquals("PrivateKeyEvmSigner[address=" + ANVIL_ADDRESS_0 + "]", text);
        assertFalse(text.toLowerCase(Locale.ROOT).contains(ANVIL_KEY_0.substring(2, 18)));
    }

    @Test
    void rejectsMalformedKeysWithoutEchoingThem() {
        String tooLong = ANVIL_KEY_0 + "00";

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> PrivateKeyEvmSigner.fromHex(tooLong));

        assertFalse(e.getMessage().contains(ANVIL_KEY_0.substring(2, 18)));
        assertThrows(IllegalArgumentException.class, () -> PrivateKeyEvmSigner.fromHex("0x" + "00".repeat(32)));
    }

    @Test
    void propagatesInvalidTypedData() {
        PrivateKeyEvmSigner signer = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0);
        Map<String, Object> incomplete = message();
        incomplete.remove("value");

        assertThrows(IllegalArgumentException.class, () -> signer.signTypedData(DOMAIN,
                EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS, EvmConstants.TRANSFER_WITH_AUTHORIZATION, incomplete));
    }

    private static Map<String, Object> message() {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("from", ANVIL_ADDRESS_0);
        message.put("to", ANVIL_ADDRESS_1);
        message.put("value", "1000");
        message.put("validAfter", "0");
        message.put("validBefore", VALID_BEFORE);
        message.put("nonce", NONCE);
        return message;
    }
}
