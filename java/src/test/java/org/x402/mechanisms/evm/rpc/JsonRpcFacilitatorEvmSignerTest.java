package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Keccak;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.client.MappingBuilder;
import com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder;
import com.github.tomakehurst.wiremock.http.Fault;
import com.github.tomakehurst.wiremock.stubbing.Scenario;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Named;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.math.BigInteger;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Named.named;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_0;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_CHAIN_ID;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.INVALID_SIGNATURE_REVERT;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.SETTLEMENT_TX;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.SETTLEMENT_TX_HASH;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TRANSFER_TOPIC;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TWA_CALLDATA;

class JsonRpcFacilitatorEvmSignerTest {

    private static final String NETWORK = "eip155:84532";
    private static final PrivateKeyEvmSigner KEY = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0);
    private static final String ADDRESS_LOWER = ANVIL_ADDRESS_0.toLowerCase(Locale.ROOT);
    private static final String USDC_LOWER = BASE_SEPOLIA_USDC.toLowerCase(Locale.ROOT);
    private static final Duration FAST_POLL = Duration.ofMillis(1);

    private static WireMockServer wm;

    @BeforeAll
    static void startServer() {
        wm = new WireMockServer(options().dynamicPort().globalTemplating(true));
        wm.start();
    }

    @AfterAll
    static void stopServer() {
        wm.stop();
    }

    @BeforeEach
    void reset() {
        wm.resetAll();
        stubResult("eth_chainId", "\"0x14a34\"");
    }

    @Test
    void connectsAndReportsAddressAndChain() throws Exception {
        JsonRpcFacilitatorEvmSigner signer = connect();

        assertEquals(List.of(ANVIL_ADDRESS_0), signer.addresses());
        assertEquals(BASE_SEPOLIA_CHAIN_ID, signer.chainId());
        assertEquals("JsonRpcFacilitatorEvmSigner[address=" + ANVIL_ADDRESS_0 + ", chainId=84532]",
                signer.toString());
    }

    @Test
    void usesAnInjectedHttpClientWithDefaultSettings() throws Exception {
        JsonRpcFacilitatorEvmSigner signer = JsonRpcFacilitatorEvmSigner.builder(NETWORK, endpoint(), KEY)
                .httpClient(HttpClient.newHttpClient())
                .connect();

        assertEquals(BASE_SEPOLIA_CHAIN_ID, signer.chainId());
        wm.verify(postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.method", equalTo("eth_chainId"))));
    }

    @Test
    void refusesAnEndpointOnAnotherChain() {
        wm.resetAll();
        stubResult("eth_chainId", "\"0x2105\"");

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, this::connect);

        assertEquals("RPC endpoint serves chain 8453, but the signer was configured for eip155:84532",
                e.getMessage());
    }

    @Test
    void validatesBuilderArguments() {
        URI url = endpoint();
        assertThrows(IllegalArgumentException.class, () -> JsonRpcFacilitatorEvmSigner.builder("solana:x", url, KEY));
        assertThrows(IllegalArgumentException.class,
                () -> JsonRpcFacilitatorEvmSigner.builder(NETWORK, URI.create("ws://localhost:8545"), KEY));
        assertThrows(IllegalArgumentException.class,
                () -> JsonRpcFacilitatorEvmSigner.builder(NETWORK, URI.create("/relative"), KEY));
        JsonRpcFacilitatorEvmSigner.Builder builder = JsonRpcFacilitatorEvmSigner.builder(NETWORK, url, KEY);
        assertThrows(IllegalArgumentException.class, () -> builder.requestTimeout(Duration.ZERO));
        assertThrows(IllegalArgumentException.class, () -> builder.receiptPollInterval(Duration.ofMillis(-1)));
    }

    @Test
    void callsFromTheFacilitatorAddressAtTheLatestBlock() throws Exception {
        stubResult("eth_call", "\"0x" + "00".repeat(31) + "01\"");

        byte[] result = connect().call(BASE_SEPOLIA_USDC, Hex.decode("0x06fdde03"));

        assertEquals(32, result.length);
        assertEquals(1, result[31]);
        wm.verify(postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.method", equalTo("eth_call")))
                .withRequestBody(matchingJsonPath("$.params[0].from", equalTo(ADDRESS_LOWER)))
                .withRequestBody(matchingJsonPath("$.params[0].to", equalTo(USDC_LOWER)))
                .withRequestBody(matchingJsonPath("$.params[0].data", equalTo("0x06fdde03")))
                .withRequestBody(matchingJsonPath("$.params[1]", equalTo("latest"))));
    }

    @Test
    void reportsRevertsWithTheDecodedReason() throws Exception {
        stubError("eth_call", 3, "execution reverted", "\"" + INVALID_SIGNATURE_REVERT + "\"");

        ContractRevertException e = assertThrows(ContractRevertException.class,
                () -> connect().call(BASE_SEPOLIA_USDC, new byte[0]));

        assertEquals("execution reverted: FiatTokenV2: invalid signature", e.getMessage());
        assertArrayEquals(Hex.decode(INVALID_SIGNATURE_REVERT), e.revertData());
        assertInstanceOf(JsonRpcException.class, e.getCause());
    }

    @Test
    void keepsTheNodeMessageWhenItAlreadyCarriesTheReason() throws Exception {
        stubError("eth_call", 3, "execution reverted: FiatTokenV2: invalid signature",
                "\"" + INVALID_SIGNATURE_REVERT + "\"");

        ContractRevertException e = assertThrows(ContractRevertException.class,
                () -> connect().call(BASE_SEPOLIA_USDC, new byte[0]));

        assertEquals("execution reverted: FiatTokenV2: invalid signature", e.getMessage());
    }

    @Test
    void recognizesRevertsByMessageWhenTheCodeIsGeneric() throws Exception {
        stubError("eth_call", -32000, "Execution Reverted", "\"not hex\"");

        ContractRevertException e = assertThrows(ContractRevertException.class,
                () -> connect().call(BASE_SEPOLIA_USDC, new byte[0]));

        assertEquals("Execution Reverted", e.getMessage());
        assertEquals(0, e.revertData().length);
    }

    @Test
    void reportsRevertsWithoutData() throws Exception {
        stubError("eth_call", 3, "execution reverted", null);

        ContractRevertException e = assertThrows(ContractRevertException.class,
                () -> connect().call(BASE_SEPOLIA_USDC, new byte[0]));

        assertEquals(0, e.revertData().length);
    }

    @Test
    void keepsOtherRpcErrorsAsJsonRpcExceptions() throws Exception {
        stubError("eth_call", -32000, "header not found", null);

        IOException e = assertThrows(IOException.class, () -> connect().call(BASE_SEPOLIA_USDC, new byte[0]));

        assertInstanceOf(JsonRpcException.class, e);
        assertFalse(e instanceof ContractRevertException);
    }

    @Test
    void rejectsInvalidAddresses() throws Exception {
        JsonRpcFacilitatorEvmSigner signer = connect();

        assertThrows(IllegalArgumentException.class, () -> signer.call("0x1234", new byte[0]));
        assertThrows(IllegalArgumentException.class, () -> signer.getCode("not an address"));
        assertThrows(IllegalArgumentException.class, () -> signer.sendTransaction("0x1234", new byte[0]));
    }

    @Test
    void readsCode() throws Exception {
        stubResult("eth_getCode", "\"0x6080\"");

        assertArrayEquals(new byte[] {0x60, (byte) 0x80}, connect().getCode(BASE_SEPOLIA_USDC));
        wm.verify(postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.params[0]", equalTo(USDC_LOWER)))
                .withRequestBody(matchingJsonPath("$.params[1]", equalTo("latest"))));
    }

    @Test
    void rejectsMalformedCode() throws Exception {
        stubResult("eth_getCode", "\"0x608\"");

        assertThrows(IOException.class, () -> connect().getCode(BASE_SEPOLIA_USDC));
    }

    @Test
    void sendsTheSameSignedTransactionAsCastMktx() throws Exception {
        stubSettlementInputs("0x7");
        stubResult("eth_sendRawTransaction", "\"" + SETTLEMENT_TX_HASH + "\"");

        String hash = connect().sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals(SETTLEMENT_TX_HASH, hash);
        wm.verify(postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.method", equalTo("eth_sendRawTransaction")))
                .withRequestBody(matchingJsonPath("$.params[0]", equalTo(SETTLEMENT_TX))));
        wm.verify(postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.method", equalTo("eth_estimateGas")))
                .withRequestBody(matchingJsonPath("$.params[0].from", equalTo(ADDRESS_LOWER)))
                .withRequestBody(matchingJsonPath("$.params[0].data", equalTo(TWA_CALLDATA))));
        wm.verify(postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.method", equalTo("eth_getTransactionCount")))
                .withRequestBody(matchingJsonPath("$.params[1]", equalTo("pending"))));
    }

    @Test
    void neverReusesANonceWhenTheNodeLagsBehind() throws Exception {
        stubSettlementInputs("0x7");
        stubResult("eth_sendRawTransaction", "\"" + SETTLEMENT_TX_HASH + "\"");
        stubRawTransaction(8);
        JsonRpcFacilitatorEvmSigner signer = connect();

        signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        String second = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals(Hex.encode(Keccak.keccak256(settlementTx(8))), second);
    }

    @Test
    void followsTheNodeWhenItsPendingNonceIsAhead() throws Exception {
        stubSettlementInputs("0x9");
        stubRawTransaction(9);

        String hash = connect().sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals(Hex.encode(Keccak.keccak256(settlementTx(9))), hash);
    }

    @Test
    void doesNotConsumeANonceWhenBroadcastFails() throws Exception {
        stubSettlementInputs("0x7");
        wm.stubFor(rpc("eth_sendRawTransaction").inScenario("broadcast")
                .whenScenarioStateIs(Scenario.STARTED).willSetStateTo("recovered")
                .willReturn(error(-32000, "replacement transaction underpriced", null)));
        wm.stubFor(rpc("eth_sendRawTransaction").inScenario("broadcast")
                .whenScenarioStateIs("recovered")
                .willReturn(result("\"" + SETTLEMENT_TX_HASH + "\"")));
        JsonRpcFacilitatorEvmSigner signer = connect();

        JsonRpcException failure = assertThrows(JsonRpcException.class,
                () -> signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));
        String retried = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals("replacement transaction underpriced", failure.rpcMessage());
        assertEquals(SETTLEMENT_TX_HASH, retried);
    }

    @Test
    void reportsRevertingGasEstimatesWithoutBroadcasting() throws Exception {
        stubSettlementInputs("0x7");
        stubError("eth_estimateGas", 3, "execution reverted: FiatTokenV2: authorization is used or canceled", null);

        ContractRevertException e = assertThrows(ContractRevertException.class,
                () -> connect().sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));

        assertEquals("execution reverted: FiatTokenV2: authorization is used or canceled", e.getMessage());
        wm.verify(0, postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.method", equalTo("eth_sendRawTransaction"))));
    }

    @Test
    void rejectsChainsWithoutBaseFee() throws Exception {
        stubSettlementInputs("0x7");
        stubResult("eth_getBlockByNumber", "{\"number\":\"0x1\"}");

        IOException e = assertThrows(IOException.class,
                () -> connect().sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));

        assertEquals("Latest block has no baseFeePerGas: the chain does not support EIP-1559", e.getMessage());
    }

    @Test
    void rejectsAMissingLatestBlock() throws Exception {
        stubSettlementInputs("0x7");
        stubResult("eth_getBlockByNumber", "null");

        IOException e = assertThrows(IOException.class,
                () -> connect().sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));

        assertEquals("eth_getBlockByNumber returned no latest block", e.getMessage());
    }

    @Test
    void rejectsOutOfRangeTransactionParameters() throws Exception {
        stubSettlementInputs("0x7");
        stubResult("eth_estimateGas", "\"0x0\"");

        IOException e = assertThrows(IOException.class,
                () -> connect().sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));

        assertTrue(e.getMessage().startsWith("Node returned out-of-range transaction parameters"));
    }

    @Test
    void returnsTheLocalHashAndSpendsTheNonceWhenTheNodeReportsAnotherHash() throws Exception {
        stubSettlementInputs("0x7");
        stubResult("eth_sendRawTransaction", "\"0x" + "ab".repeat(32) + "\"");
        JsonRpcFacilitatorEvmSigner signer = connect();

        String first = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        stubResult("eth_sendRawTransaction", "\"0x123\"");
        String second = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals(SETTLEMENT_TX_HASH, first);
        assertEquals(Hex.encode(Keccak.keccak256(settlementTx(8))), second);
    }

    @Test
    void reportsABroadcastWhoseReplyTimesOutWithTheLocalHashWithoutSpendingTheNonce() throws Exception {
        stubSettlementInputs("0x7");
        wm.stubFor(rpc("eth_sendRawTransaction")
                .willReturn(result("\"" + SETTLEMENT_TX_HASH + "\"").withFixedDelay(4000)));
        JsonRpcFacilitatorEvmSigner signer = builder().requestTimeout(Duration.ofSeconds(1)).connect();

        BroadcastOutcomeUnknownException e = assertThrows(BroadcastOutcomeUnknownException.class,
                () -> signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));
        stubResult("eth_sendRawTransaction", "\"" + SETTLEMENT_TX_HASH + "\"");
        String retried = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals(SETTLEMENT_TX_HASH, e.transactionHash());
        assertEquals("eth_sendRawTransaction: no response within PT1S; transaction " + SETTLEMENT_TX_HASH
                + " may still be mined", e.getMessage());
        assertInstanceOf(HttpTimeoutException.class, e.getCause());
        assertEquals(SETTLEMENT_TX_HASH, retried, "the nonce is not spent");
    }

    @ParameterizedTest
    @MethodSource("lostBroadcastReplies")
    void reportsABroadcastWhoseReplyIsLostWithTheLocalHashWithoutSpendingTheNonce(ResponseDefinitionBuilder reply)
            throws Exception {
        stubSettlementInputs("0x7");
        wm.stubFor(rpc("eth_sendRawTransaction").willReturn(reply));
        JsonRpcFacilitatorEvmSigner signer = connect();

        BroadcastOutcomeUnknownException e = assertThrows(BroadcastOutcomeUnknownException.class,
                () -> signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));
        stubResult("eth_sendRawTransaction", "\"" + SETTLEMENT_TX_HASH + "\"");
        String retried = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals(SETTLEMENT_TX_HASH, e.transactionHash());
        assertTrue(e.getMessage().startsWith("eth_sendRawTransaction: "), e.getMessage());
        assertTrue(e.getMessage().endsWith("; transaction " + SETTLEMENT_TX_HASH + " may still be mined"),
                e.getMessage());
        assertEquals(SETTLEMENT_TX_HASH, retried, "the nonce is not spent");
    }

    static Stream<Named<ResponseDefinitionBuilder>> lostBroadcastReplies() {
        return Stream.of(
                named("gateway timeout", aResponse().withStatus(504).withBody("upstream timed out")),
                named("connection reset after the request", aResponse().withFault(Fault.CONNECTION_RESET_BY_PEER)),
                named("unreadable reply", aResponse().withStatus(200).withBody("<html>")));
    }

    @Test
    void reportsABroadcastTheEndpointRefusesWithA4xxStatusAsAPlainFailure() throws Exception {
        stubSettlementInputs("0x7");
        wm.stubFor(rpc("eth_sendRawTransaction").willReturn(aResponse().withStatus(429)));
        JsonRpcFacilitatorEvmSigner signer = connect();

        HttpStatusException e = assertThrows(HttpStatusException.class,
                () -> signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));

        assertEquals(429, e.status());
        assertEquals("eth_sendRawTransaction: HTTP status 429", e.getMessage());
    }

    @ParameterizedTest
    @MethodSource("connectFailures")
    void reportsABroadcastThatCouldNotConnectAsAPlainFailure(IOException failure) throws Exception {
        stubSettlementInputs("0x7");
        HttpClient real = HttpClient.newHttpClient();
        HttpClient client = mock(HttpClient.class);
        AtomicInteger exchanges = new AtomicInteger();
        // eth_chainId, eth_estimateGas, eth_maxPriorityFeePerGas, eth_getBlockByNumber, eth_getTransactionCount,
        // then eth_sendRawTransaction
        when(client.sendAsync(any(), any())).thenAnswer(invocation -> exchanges.incrementAndGet() == 6
                ? CompletableFuture.failedFuture(failure)
                : real.sendAsync(invocation.getArgument(0), invocation.getArgument(1)));
        JsonRpcFacilitatorEvmSigner signer = builder().httpClient(client).connect();

        IOException e = assertThrows(IOException.class,
                () -> signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));

        assertFalse(e instanceof BroadcastOutcomeUnknownException, e.toString());
        assertSame(failure, e.getCause());
        assertEquals(6, exchanges.get());
    }

    static Stream<IOException> connectFailures() {
        return Stream.of(new HttpConnectTimeoutException("HTTP connect timed out"),
                new ConnectException("Connection refused"));
    }

    @Test
    void reportsAnInterruptedBroadcastWithTheLocalHashAndKeepsTheInterrupt() throws Exception {
        stubSettlementInputs("0x7");
        wm.stubFor(rpc("eth_sendRawTransaction")
                .willReturn(result("\"" + SETTLEMENT_TX_HASH + "\"").withFixedDelay(4000)));
        JsonRpcFacilitatorEvmSigner signer = connect();
        AtomicReference<Exception> thrown = new AtomicReference<>();
        AtomicBoolean interrupted = new AtomicBoolean();
        Thread sender = new Thread(() -> {
            try {
                signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
            } catch (IOException | InterruptedException e) {
                thrown.set(e);
            }
            interrupted.set(Thread.currentThread().isInterrupted());
        });

        sender.start();
        awaitRequests("eth_sendRawTransaction", 1);
        sender.interrupt();
        sender.join(Duration.ofSeconds(5).toMillis());

        BroadcastOutcomeUnknownException e = assertInstanceOf(BroadcastOutcomeUnknownException.class, thrown.get());
        assertEquals(SETTLEMENT_TX_HASH, e.transactionHash());
        assertEquals("eth_sendRawTransaction: interrupted; transaction " + SETTLEMENT_TX_HASH + " may still be mined",
                e.getMessage());
        assertTrue(interrupted.get(), "the interrupt flag must be restored");
    }

    @Test
    void readsGasAndFeesWithoutWaitingForAnotherSendToBroadcast() throws Exception {
        stubSettlementInputs("0x7");
        byte[] slow = settlementTx(7);
        wm.stubFor(rpc("eth_sendRawTransaction")
                .withRequestBody(matchingJsonPath("$.params[0]", equalTo(Hex.encode(slow))))
                .willReturn(result("\"" + Hex.encode(Keccak.keccak256(slow)) + "\"").withFixedDelay(3000)));
        stubRawTransaction(8);
        JsonRpcFacilitatorEvmSigner signer = connect();
        Callable<String> send = () -> signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<String> first = pool.submit(send);
            awaitRequests("eth_sendRawTransaction", 1);
            Future<String> second = pool.submit(send);
            awaitRequests("eth_getBlockByNumber", 2);

            assertFalse(first.isDone(), "the second send read its gas and fees while the first held the lock");
            assertEquals(hashWithNonce(7), first.get());
            assertEquals(hashWithNonce(8), second.get());
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void reusesTheNonceOfATransactionTheNodeNeverShowsAfterTwoMinutes() throws Exception {
        FakeTime time = new FakeTime();
        stubSettlementInputs("0x7");
        for (int nonce = 7; nonce <= 9; nonce++) {
            stubRawTransaction(nonce);
        }
        JsonRpcFacilitatorEvmSigner signer = builder().timeSource(time).connect();

        String first = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        String second = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        time.advance(JsonRpcFacilitatorEvmSigner.NONCE_RESYNC_AFTER.minusSeconds(1));
        String third = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        time.advance(Duration.ofSeconds(1));
        String resynced = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        String next = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals(List.of(hashWithNonce(7), hashWithNonce(8), hashWithNonce(9), hashWithNonce(7),
                hashWithNonce(8)), List.of(first, second, third, resynced, next));
        assertEquals(Duration.ofMinutes(2), JsonRpcFacilitatorEvmSigner.NONCE_RESYNC_AFTER);
    }

    @Test
    void keepsTheNonceFloorWhileTheNodeIsCatchingUp() throws Exception {
        FakeTime time = new FakeTime();
        stubSettlementInputs("0x7");
        for (int nonce = 7; nonce <= 10; nonce++) {
            stubRawTransaction(nonce);
        }
        JsonRpcFacilitatorEvmSigner signer = builder().timeSource(time).connect();

        signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        time.advance(Duration.ofSeconds(90));
        stubResult("eth_getTransactionCount", "\"0x8\"");
        String afterProgress = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));
        time.advance(Duration.ofSeconds(90));
        String later = signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA));

        assertEquals(hashWithNonce(9), afterProgress);
        assertEquals(hashWithNonce(10), later, "the node moved within the last two minutes, so it only lags");
    }

    @Test
    void serializesConcurrentSendsSoEveryNonceIsUsedOnce() throws Exception {
        int senders = 6;
        stubSettlementInputs("0x7");
        Set<String> expected = new HashSet<>();
        for (int nonce = 7; nonce < 7 + senders; nonce++) {
            stubRawTransaction(nonce);
            expected.add(Hex.encode(Keccak.keccak256(settlementTx(nonce))));
        }
        JsonRpcFacilitatorEvmSigner signer = connect();
        ExecutorService pool = Executors.newFixedThreadPool(senders);
        try {
            List<Callable<String>> tasks = new ArrayList<>();
            for (int i = 0; i < senders; i++) {
                tasks.add(() -> signer.sendTransaction(BASE_SEPOLIA_USDC, Hex.decode(TWA_CALLDATA)));
            }
            Set<String> hashes = new HashSet<>();
            for (Future<String> future : pool.invokeAll(tasks)) {
                hashes.add(future.get());
            }
            assertEquals(expected, hashes);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void pollsUntilTheReceiptIsMined() throws Exception {
        wm.stubFor(rpc("eth_getTransactionReceipt").inScenario("mining")
                .whenScenarioStateIs(Scenario.STARTED).willSetStateTo("mined")
                .willReturn(result("null")));
        wm.stubFor(rpc("eth_getTransactionReceipt").inScenario("mining")
                .whenScenarioStateIs("mined")
                .willReturn(result(receiptJson(SETTLEMENT_TX_HASH, "0x1", logJson()))));

        TransactionReceipt receipt = connect().waitForReceipt(SETTLEMENT_TX_HASH, Duration.ofSeconds(5));

        assertEquals(SETTLEMENT_TX_HASH, receipt.transactionHash());
        assertEquals(0x2a, receipt.blockNumber());
        assertTrue(receipt.successful());
        assertEquals(1, receipt.logs().size());
        TransactionReceipt.Log log = receipt.logs().get(0);
        assertEquals(USDC_LOWER, log.address());
        assertEquals(TRANSFER_TOPIC, log.topics().get(0));
        assertEquals("0x" + "00".repeat(30) + "03e8", log.data());
    }

    @Test
    void reportsRevertedTransactions() throws Exception {
        stubResult("eth_getTransactionReceipt", receiptJson(SETTLEMENT_TX_HASH, "0x0", ""));

        TransactionReceipt receipt = connect().waitForReceipt(SETTLEMENT_TX_HASH, Duration.ofSeconds(5));

        assertFalse(receipt.successful());
        assertEquals(List.of(), receipt.logs());
    }

    @Test
    void timesOutWhenTheTransactionIsNeverMined() throws Exception {
        stubResult("eth_getTransactionReceipt", "null");
        FakeTime time = new FakeTime();
        JsonRpcFacilitatorEvmSigner signer =
                builder().receiptPollInterval(Duration.ofSeconds(1)).timeSource(time).connect();

        IOException e = assertThrows(IOException.class,
                () -> signer.waitForReceipt(SETTLEMENT_TX_HASH, Duration.ofMillis(2500)));

        assertEquals("No receipt for " + SETTLEMENT_TX_HASH + " within PT2.5S", e.getMessage());
        assertEquals(3, requests("eth_getTransactionReceipt"));
        assertEquals(List.of(1_000_000_000L, 1_000_000_000L, 500_000_000L), time.sleeps);
    }

    @Test
    void keepsPollingThroughNodeErrorsAndReportsTheLastOne() throws Exception {
        wm.stubFor(rpc("eth_getTransactionReceipt").inScenario("flaky")
                .whenScenarioStateIs(Scenario.STARTED).willSetStateTo("up")
                .willReturn(error(-32000, "backend unavailable", null)));
        wm.stubFor(rpc("eth_getTransactionReceipt").inScenario("flaky")
                .whenScenarioStateIs("up")
                .willReturn(result(receiptJson(SETTLEMENT_TX_HASH, "0x1", ""))));
        FakeTime time = new FakeTime();
        JsonRpcFacilitatorEvmSigner signer =
                builder().receiptPollInterval(Duration.ofSeconds(1)).timeSource(time).connect();

        TransactionReceipt receipt = signer.waitForReceipt(SETTLEMENT_TX_HASH, Duration.ofSeconds(5));

        assertEquals(SETTLEMENT_TX_HASH, receipt.transactionHash());
        assertEquals(2, requests("eth_getTransactionReceipt"));
    }

    @Test
    void reportsTheLastNodeErrorWhenNoReceiptArrives() throws Exception {
        stubError("eth_getTransactionReceipt", -32000, "backend unavailable", null);
        JsonRpcFacilitatorEvmSigner signer =
                builder().receiptPollInterval(Duration.ofSeconds(1)).timeSource(new FakeTime()).connect();

        IOException e = assertThrows(IOException.class,
                () -> signer.waitForReceipt(SETTLEMENT_TX_HASH, Duration.ofSeconds(3)));

        assertEquals("No receipt for " + SETTLEMENT_TX_HASH + " within PT3S; last error: "
                + "eth_getTransactionReceipt: backend unavailable (code -32000)", e.getMessage());
        assertInstanceOf(JsonRpcException.class, e.getCause());
        assertEquals(3, requests("eth_getTransactionReceipt"));
    }

    @Test
    void boundsEachReceiptPollByTheTimeLeft() throws Exception {
        wm.stubFor(rpc("eth_getTransactionReceipt").willReturn(result("null").withFixedDelay(3000)));
        JsonRpcFacilitatorEvmSigner signer =
                builder().receiptPollInterval(Duration.ofSeconds(1)).timeSource(new FakeTime()).connect();

        IOException e = assertThrows(IOException.class,
                () -> signer.waitForReceipt(SETTLEMENT_TX_HASH, Duration.ofMillis(200)));

        assertEquals("No receipt for " + SETTLEMENT_TX_HASH + " within PT0.2S; last error: "
                + "eth_getTransactionReceipt: no response within PT0.2S", e.getMessage());
        assertInstanceOf(HttpTimeoutException.class, e.getCause());
    }

    @Test
    void doesNotPollWithAZeroTimeout() throws Exception {
        IOException e = assertThrows(IOException.class,
                () -> connect().waitForReceipt(SETTLEMENT_TX_HASH, Duration.ZERO));

        assertEquals("No receipt for " + SETTLEMENT_TX_HASH + " within PT0S", e.getMessage());
        assertEquals(0, requests("eth_getTransactionReceipt"));
    }

    @Test
    void rejectsMalformedReceipts() throws Exception {
        String other = "0x" + "cd".repeat(32);
        List<String> malformed = List.of(
                "\"0x1\"",
                receiptJson(other, "0x1", ""),
                receiptJson(SETTLEMENT_TX_HASH, "0x2", ""),
                receiptJson(SETTLEMENT_TX_HASH, "0x1", "").replace("\"blockNumber\":\"0x2a\"",
                        "\"blockNumber\":\"0x8000000000000000\""),
                receiptJson(SETTLEMENT_TX_HASH, "0x1", "").replace(",\"logs\":[]", ""),
                receiptJson(SETTLEMENT_TX_HASH, "0x1", "{\"address\":\"" + BASE_SEPOLIA_USDC + "\"}"),
                receiptJson(SETTLEMENT_TX_HASH, "0x1",
                        "{\"address\":\"" + BASE_SEPOLIA_USDC + "\",\"topics\":[7],\"data\":\"0x\"}"),
                receiptJson(SETTLEMENT_TX_HASH, "0x1",
                        "{\"address\":\"" + BASE_SEPOLIA_USDC + "\",\"topics\":[\"0x01\"],\"data\":\"0x\"}"));
        JsonRpcFacilitatorEvmSigner signer =
                builder().receiptPollInterval(Duration.ofSeconds(1)).timeSource(new FakeTime()).connect();
        for (String receipt : malformed) {
            wm.resetAll();
            stubResult("eth_getTransactionReceipt", receipt);

            IOException e = assertThrows(IOException.class,
                    () -> signer.waitForReceipt(SETTLEMENT_TX_HASH, Duration.ofSeconds(1)), receipt);

            assertTrue(e.getMessage().startsWith("No receipt for " + SETTLEMENT_TX_HASH), e.getMessage());
            assertTrue(e.getMessage().contains("; last error: "), e.getMessage());
        }
    }

    @Test
    void validatesReceiptArguments() throws Exception {
        JsonRpcFacilitatorEvmSigner signer = connect();

        assertThrows(IllegalArgumentException.class, () -> signer.waitForReceipt("0x1234", Duration.ofSeconds(1)));
        assertThrows(IllegalArgumentException.class,
                () -> signer.waitForReceipt(SETTLEMENT_TX_HASH, Duration.ofSeconds(-1)));
    }

    @Test
    void sendsToTheChecksummedOrLowercaseAddressAlike() throws Exception {
        stubResult("eth_getCode", "\"0x\"");
        JsonRpcFacilitatorEvmSigner signer = connect();

        assertEquals(0, signer.getCode(ANVIL_ADDRESS_1).length);
        assertEquals(0, signer.getCode(ANVIL_ADDRESS_1.substring(2).toUpperCase(Locale.ROOT)).length);
    }

    private JsonRpcFacilitatorEvmSigner connect() throws IOException, InterruptedException {
        return builder().connect();
    }

    private static JsonRpcFacilitatorEvmSigner.Builder builder() {
        return JsonRpcFacilitatorEvmSigner.builder(NETWORK, endpoint(), KEY)
                .requestTimeout(Duration.ofSeconds(5))
                .receiptPollInterval(FAST_POLL);
    }

    private static String hashWithNonce(int nonce) {
        return Hex.encode(Keccak.keccak256(settlementTx(nonce)));
    }

    private static int requests(String method) {
        return wm.findAll(postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.method", equalTo(method)))).size();
    }

    /** Waits until the node has received {@code count} requests for a method. */
    private static void awaitRequests(String method, int count) throws InterruptedException {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (requests(method) < count) {
            if (System.nanoTime() > deadline) {
                fail("the node never received " + count + " " + method + " requests");
            }
            Thread.sleep(5);
        }
    }

    /** A monotonic clock that moves only when the test advances it or the signer sleeps. */
    private static final class FakeTime implements JsonRpcFacilitatorEvmSigner.TimeSource {

        private final List<Long> sleeps = new ArrayList<>();
        private long now;

        @Override
        public long nanoTime() {
            return now;
        }

        @Override
        public void sleep(long nanos) {
            sleeps.add(nanos);
            now += nanos;
        }

        void advance(Duration duration) {
            now += duration.toNanos();
        }
    }

    /** Node answers for a settlement with a gas estimate of 80000, a 1 gwei tip and a base fee of 500000050. */
    private static void stubSettlementInputs(String pendingNonce) {
        stubResult("eth_getTransactionCount", "\"" + pendingNonce + "\"");
        stubResult("eth_estimateGas", "\"0x13880\"");
        stubResult("eth_maxPriorityFeePerGas", "\"0x3b9aca00\"");
        stubResult("eth_getBlockByNumber", "{\"number\":\"0x2a\",\"baseFeePerGas\":\"0x1dcd6532\"}");
    }

    private static void stubRawTransaction(int nonce) {
        byte[] raw = settlementTx(nonce);
        wm.stubFor(rpc("eth_sendRawTransaction")
                .withRequestBody(matchingJsonPath("$.params[0]", equalTo(Hex.encode(raw))))
                .willReturn(result("\"" + Hex.encode(Keccak.keccak256(raw)) + "\"")));
    }

    /** The settlement transaction of {@link RpcCastVectors#SETTLEMENT_TX} with another nonce. */
    private static byte[] settlementTx(int nonce) {
        Eip1559Transaction transaction = new Eip1559Transaction(BASE_SEPOLIA_CHAIN_ID, BigInteger.valueOf(nonce),
                BigInteger.valueOf(1_000_000_000L), BigInteger.valueOf(2_000_000_100L), BigInteger.valueOf(96_000),
                BASE_SEPOLIA_USDC, BigInteger.ZERO, Hex.decode(TWA_CALLDATA));
        return transaction.encodeSigned(KEY.signDigest(transaction.signingHash()));
    }

    private static String receiptJson(String hash, String status, String logs) {
        return "{\"transactionHash\":\"" + hash + "\",\"blockNumber\":\"0x2a\",\"status\":\"" + status
                + "\",\"logs\":[" + logs + "]}";
    }

    private static String logJson() {
        return "{\"address\":\"" + USDC_LOWER + "\",\"topics\":[\"" + TRANSFER_TOPIC + "\",\"0x"
                + "00".repeat(12) + ADDRESS_LOWER.substring(2) + "\",\"0x" + "00".repeat(32) + "\"],\"data\":\"0x"
                + "00".repeat(30) + "03e8\"}";
    }

    private static URI endpoint() {
        return URI.create("http://localhost:" + wm.port() + "/rpc");
    }

    private static MappingBuilder rpc(String method) {
        return post(urlEqualTo("/rpc")).withRequestBody(matchingJsonPath("$.method", equalTo(method)));
    }

    private static void stubResult(String method, String resultJson) {
        wm.stubFor(rpc(method).willReturn(result(resultJson)));
    }

    private static void stubError(String method, int code, String message, String dataJson) {
        wm.stubFor(rpc(method).willReturn(error(code, message, dataJson)));
    }

    private static ResponseDefinitionBuilder result(String resultJson) {
        return aResponse().withHeader("Content-Type", "application/json")
                .withBody("{\"jsonrpc\":\"2.0\",\"id\":{{jsonPath request.body '$.id'}},\"result\":"
                        + resultJson + "}");
    }

    private static ResponseDefinitionBuilder error(
            int code, String message, String dataJson) {
        String data = dataJson == null ? "" : ",\"data\":" + dataJson;
        return aResponse().withHeader("Content-Type", "application/json")
                .withBody("{\"jsonrpc\":\"2.0\",\"id\":{{jsonPath request.body '$.id'}},\"error\":{\"code\":" + code
                        + ",\"message\":\"" + message + "\"" + data + "}}");
    }
}
