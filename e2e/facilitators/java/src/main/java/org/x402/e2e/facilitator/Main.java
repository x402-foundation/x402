package org.x402.e2e.facilitator;

import org.x402.X402Facilitator;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.exact.ExactEvmFacilitatorScheme;
import org.x402.mechanisms.evm.rpc.JsonRpcFacilitatorEvmSigner;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * x402 Java facilitator for e2e runs, mirroring {@code e2e/facilitators/go/main.go} for the exact EVM scheme: it
 * verifies EIP-3009 payments on {@code EVM_NETWORK} and settles them from the {@code FACILITATOR_EVM_PRIVATE_KEY}
 * account through {@code EVM_RPC_URL}.
 */
public final class Main {

    private static final String DEFAULT_PORT = "4022";
    private static final String BASE_MAINNET = "eip155:8453";

    private Main() {
    }

    public static void main(String[] args) {
        try {
            start(System.getenv());
        } catch (Exception e) {
            System.err.println("Failed to start facilitator: " + e.getMessage());
            System.exit(1);
        }
    }

    private static void start(Map<String, String> env) throws IOException, InterruptedException {
        int port = Integer.parseInt(env.getOrDefault("PORT", DEFAULT_PORT));
        String network = evmNetwork(env);
        String rpcUrl = env.getOrDefault("EVM_RPC_URL",
                BASE_MAINNET.equals(network) ? "https://mainnet.base.org" : "https://sepolia.base.org");
        String privateKey = env.get("FACILITATOR_EVM_PRIVATE_KEY");
        if (privateKey == null || privateKey.isBlank()) {
            throw new IllegalStateException("FACILITATOR_EVM_PRIVATE_KEY is required");
        }

        JsonRpcFacilitatorEvmSigner signer = JsonRpcFacilitatorEvmSigner
                .builder(network, URI.create(rpcUrl), PrivateKeyEvmSigner.fromHex(privateKey))
                .connect();
        X402Facilitator facilitator = X402Facilitator.builder()
                .register(List.of(network), new ExactEvmFacilitatorScheme(signer))
                .build();

        Map<String, Object> health = new LinkedHashMap<>();
        health.put("status", "ok");
        health.put("evmNetwork", network);
        health.put("facilitator", "java");
        health.put("version", "2.0.0");
        health.put("extensions", List.of());
        new FacilitatorServer(facilitator, health).start(port);

        String address = "http://localhost:" + port;
        System.out.println(String.join(System.lineSeparator(),
                "x402 Java Facilitator",
                "  Server:      " + address,
                "  EVM network: " + network,
                "  Address:     " + signer.addresses().get(0),
                "  POST /verify, POST /settle, GET /supported, GET /health, POST /close",
                // The harness waits for this line before it polls /health.
                "Facilitator listening on " + address));
    }

    /** Returns {@code EVM_NETWORK}, or the catalog's EVM testnet when it is unset, as Go's resolveNetworkCaip2. */
    private static String evmNetwork(Map<String, String> env) throws IOException {
        String fromEnv = env.get("EVM_NETWORK");
        if (fromEnv != null && !fromEnv.isBlank()) {
            return fromEnv;
        }
        List<Path> catalogDirs = new ArrayList<>();
        String injected = env.get("E2E_MECHANISMS_CATALOG");
        if (injected != null && !injected.isBlank()) {
            catalogDirs.add(Path.of(injected));
        }
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            catalogDirs.add(dir.resolve("config"));
        }
        for (Path dir : catalogDirs) {
            Path file = dir.resolve("mechanisms_evm.json");
            if (Files.isRegularFile(file)) {
                return new ObjectMapper().readTree(file.toFile()).path("testnet").path("caip2").asText();
            }
        }
        throw new IOException("EVM_NETWORK is unset and mechanisms_evm.json could not be located");
    }
}
