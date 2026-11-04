# x402 Java SDK

Java implementation of the [x402 protocol](https://github.com/x402-foundation/x402), version 2. A client pays for x402-protected HTTP resources, a resource server charges for the routes of a servlet application, and a facilitator verifies payments and settles them onchain. Payments use the `exact` scheme on EVM networks with EIP-3009 `transferWithAuthorization`. The core classes `X402Client`, `X402ResourceServer` and `X402Facilitator` do not depend on HTTP. The HTTP layer is built on `java.net.http` and Jakarta Servlet.

The x402 v1 SDK lives in [`legacy/`](legacy/README.md). It is deprecated and only receives security patches.

## Requirements

- Java 17 or later.
- Jakarta Servlet 5.0 or later for `PaymentFilter`, e.g. Tomcat 10+, Jetty 11+ or Spring Boot 3. The servlet API is a `provided` dependency.
- Jackson Databind and Bouncy Castle (`bcprov-jdk18on`), pulled in by Maven.

## Installation

The SDK is not published to a Maven repository yet. Build it and install it into your local repository:

```bash
git clone https://github.com/x402-foundation/x402.git
cd x402/java
mvn -B install
```

Then add the dependency:

```xml
<dependency>
  <groupId>org.x402</groupId>
  <artifactId>x402</artifactId>
  <version>2.0.0-SNAPSHOT</version>
</dependency>
```

## Quick start

### Client

`X402HttpClient` wraps `java.net.http.HttpClient`. When a server answers `402`, it selects one of the offered payment options, signs an EIP-3009 authorization and sends the request again with a `PAYMENT-SIGNATURE` header. A request is never paid more than once.

```java
import org.x402.X402Client;
import org.x402.http.X402HttpClient;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.exact.ExactEvmClientScheme;

import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

PrivateKeyEvmSigner signer = PrivateKeyEvmSigner.fromHex(System.getenv("EVM_PRIVATE_KEY"));

X402Client client = X402Client.builder()
        .register("eip155:*", new ExactEvmClientScheme(signer)) // every EVM network
        .build();

X402HttpClient http = new X402HttpClient(client);
HttpResponse<String> response = http.send(
        HttpRequest.newBuilder(URI.create("http://localhost:8080/weather")).build(),
        HttpResponse.BodyHandlers.ofString());

X402HttpClient.settleResponse(response)
        .ifPresent(settlement -> System.out.println("Paid in transaction " + settlement.transaction()));
```

If none of the offered options can be paid, `send` throws a `PaymentException` whose `reason()` says why. `X402Client.Builder` also takes `spendControls`, `policy` and `selector` to bound, filter and pick the options. To keep the key in a KMS or HSM, implement `ClientEvmSigner` instead of using `PrivateKeyEvmSigner`. Its Javadoc specifies the exact signature format.

### Resource server

`HttpResourceServer` maps route patterns to prices. `PaymentFilter` enforces them in any servlet container.

```java
import org.x402.Price;
import org.x402.X402ResourceServer;
import org.x402.http.HttpFacilitatorClient;
import org.x402.http.HttpResourceServer;
import org.x402.http.PaymentOption;
import org.x402.http.RouteConfig;
import org.x402.http.servlet.PaymentFilter;
import org.x402.mechanisms.evm.exact.ExactEvmServerScheme;

import java.util.LinkedHashMap;
import java.util.Map;

X402ResourceServer resourceServer = X402ResourceServer.builder()
        .facilitator(HttpFacilitatorClient.builder().url("https://x402.org/facilitator").build())
        .register("eip155:84532", new ExactEvmServerScheme())
        .build();

Map<String, RouteConfig> routes = new LinkedHashMap<>();
routes.put("GET /weather", RouteConfig.builder()
        .accept(PaymentOption.builder()
                .scheme("exact")
                .network("eip155:84532")
                .payTo(System.getenv("EVM_PAYEE_ADDRESS"))
                .price(Price.money("$0.001")) // 1000 atomic units of Base Sepolia USDC
                .build())
        .description("Current weather")
        .mimeType("application/json")
        .build());

PaymentFilter filter = new PaymentFilter(new HttpResourceServer(resourceServer, routes));
```

Register the filter with the container, for example from a `ServletContextListener`:

```java
FilterRegistration.Dynamic registration = servletContext.addFilter("x402", filter);
registration.addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST, DispatcherType.FORWARD), false, "/*");
```

With Spring Boot 3, declare a `FilterRegistrationBean` in a `@Configuration` class:

```java
@Bean
FilterRegistrationBean<PaymentFilter> x402Filter(HttpResourceServer payments) {
    FilterRegistrationBean<PaymentFilter> registration = new FilterRegistrationBean<>(new PaymentFilter(payments));
    registration.addUrlPatterns("/*");
    registration.setDispatcherTypes(DispatcherType.REQUEST, DispatcherType.FORWARD);
    return registration;
}
```

- Map the filter for `FORWARD` as well as `REQUEST`. Routes match the dispatched path, so without `FORWARD` a free URL that forwards to a paid path serves it unpaid.
- `PaymentFilter.init` fetches `/supported` from every facilitator and builds the payment requirements of every route. A misconfigured route stops the filter from starting. If a facilitator cannot be reached, the filter logs a warning and starts anyway. Paid requests then retry initialization, at most once every 5 seconds, and get a `503` with `{"error":"facilitator_unavailable"}` until a retry succeeds, or a `500` if a retry finds a misconfigured route.
- A route pattern is `"METHOD /path"` or a bare `"/path"`, which matches every method except `OPTIONS`. In the path, `*` matches any characters and `:id` or `[id]` matches one segment. Paths are relative to the servlet context path. Routes are tried in map order and the first match wins.
- The handler finds the verified payment in the request attributes `PaymentFilter.PAYMENT_PAYLOAD_ATTRIBUTE` and `PaymentFilter.PAYMENT_REQUIREMENTS_ATTRIBUTE`.
- `Price.money` resolves to the network's default asset. To charge in another EIP-3009 token, set the price to an amount in atomic units with the token's EIP-712 domain, e.g. `new AssetAmount("1000", tokenAddress, Map.of("name", "My Token", "version", "1"))`.

### Facilitator

`X402Facilitator` routes each payment to the scheme registered for its network. `ExactEvmFacilitatorScheme` verifies the EIP-3009 authorization, including an `eth_call` simulation of the transfer, and settles it by submitting `transferWithAuthorization` from the facilitator's account, which pays the gas.

```java
import org.x402.X402Facilitator;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.exact.ExactEvmFacilitatorScheme;
import org.x402.mechanisms.evm.rpc.JsonRpcFacilitatorEvmSigner;

import java.net.URI;
import java.util.List;

JsonRpcFacilitatorEvmSigner signer = JsonRpcFacilitatorEvmSigner
        .builder("eip155:84532", URI.create(System.getenv("EVM_RPC_URL")),
                PrivateKeyEvmSigner.fromHex(System.getenv("FACILITATOR_EVM_PRIVATE_KEY")))
        .connect(); // fails unless eth_chainId is 84532

X402Facilitator facilitator = X402Facilitator.builder()
        .register(List.of("eip155:84532"), new ExactEvmFacilitatorScheme(signer))
        .build();
```

A `JsonRpcFacilitatorEvmSigner` is bound to one chain. To serve several networks, create a signer and an `ExactEvmFacilitatorScheme` per network and register each one under its own network. A settle result with the reason `settlement_pending` carries the hash of a broadcast transaction whose receipt did not arrive in time. It is not final and must be reconciled onchain.

`X402Facilitator` implements `FacilitatorClient`, so a resource server can use it in-process instead of `HttpFacilitatorClient`:

```java
X402ResourceServer resourceServer = X402ResourceServer.builder()
        .facilitator(facilitator)
        .register("eip155:84532", new ExactEvmServerScheme())
        .build();
```

The SDK does not include an HTTP server for the facilitator. To run one, delegate `POST /verify` and `POST /settle`, whose body is a `FacilitatorRequest`, and `GET /supported` to `verify`, `settle` and `supported`.

## Supported

- x402 protocol version 2, with the `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` headers.
- The `exact` scheme on EVM (`eip155`) networks with EIP-3009, for clients, resource servers and facilitators.
- Money prices such as `Price.money("$0.01")` on the networks below, whose default asset supports EIP-3009. The table comes from `DefaultAssets`.

| Network | Mainnet | Testnet | Default asset |
|---------|---------|---------|---------------|
| Base | `eip155:8453` | `eip155:84532` | USDC |
| Ethereum | `eip155:1` | | USDC |
| Arbitrum | `eip155:42161` | `eip155:421614` | USDC |
| Avalanche C-Chain | `eip155:43114` | | USDC |
| Polygon | `eip155:137` | | USDC |
| Monad | `eip155:143` | `eip155:10143` | USDC |
| Stable | `eip155:988` | `eip155:2201` | USDT0 |
| ADI | `eip155:36900` | | USDC.e |
| HPP | `eip155:190415` | `eip155:181228` | USDC.e |
| XDC | `eip155:50` | `eip155:51` | USDC |
| Flare | `eip155:14` | | USDT0 |
| Celo | `eip155:42220` | `eip155:11142220` | USDC, plus USDT and USAT by symbol on mainnet |
| Sei | `eip155:1329` | `eip155:1328` | USDC |
| Arc | `eip155:5042` | `eip155:5042002` | USDC |
| World Chain | `eip155:480` | `eip155:4801` | USDC |

Other EVM networks work with an `AssetAmount` price of an EIP-3009 token. Clients must then allow that token with `SpendControls.Builder.allowAsset`.

Not supported yet:

- The `permit2` asset transfer method. Networks whose default asset uses Permit2 (MegaETH, Mezo, Radius, Igra) need an `AssetAmount` of an EIP-3009 token.
- The `upto`, `batch-settlement` and `auth-capture` schemes.
- SVM and every other network family.
- Extensions, lifecycle hooks, dynamic `payTo` and price, the paywall and MCP.
- Smart-wallet signatures (ERC-1271, ERC-6492). The facilitator only verifies signatures of externally owned accounts.
- x402 v1, which lives in [`legacy/`](legacy/README.md).

## Security

- **Spend controls are on by default.** The client only pays in the networks' default assets, which are USD stablecoins, and at most $1 per payment. Raise the cap with `SpendControls.builder().maxAmountPerPayment("$5")` and allow other tokens with `allowAsset`. Use `SpendControls.disabled()` only with servers you trust. The controls are checked again when the payment is signed.
- **Settlement before delivery.** `PaymentFilter` buffers the handler's response and releases it only after settlement succeeds. If settlement fails, the client gets a `402` with `{"error":"settlement_failed"}` and nothing the handler produced, headers and cookies included. A handler status of 400 or above is released without settling. Paid routes must run synchronously, since `startAsync` is rejected, and their whole body is held in memory.
- **Path normalization.** Routes are matched against both the raw request URI and the path the container dispatched on, after resolving percent-escapes, `;` parameters and `.` or `..` segments. A request for `/public/..;/premium` or `/public/%2e%2e/premium` cannot reach a paid `/premium` handler without paying. Matching is case-sensitive.
- **Secrets.** `PrivateKeyEvmSigner` has no key accessor and its `toString` prints only the address. `JsonRpcFacilitatorEvmSigner.toString` omits the RPC URL, which often embeds an API key. `HttpFacilitatorClient` rejects URLs that carry credentials. Pass them with `authHeadersProvider` instead.

## Development

```bash
cd java
mvn -B verify -Pcoverage   # build, unit tests, Checkstyle and the JaCoCo coverage gate
mvn -B spotbugs:check      # static analysis
```

The coverage gate requires 85% instruction and 75% branch coverage.

`ExactEvmPaymentFlowAnvilTest` verifies and settles real payments against an [anvil](https://github.com/foundry-rs/foundry) fork of Base Sepolia. It is skipped unless `X402_TEST_EVM_RPC_URL` is set:

```bash
anvil --fork-url https://sepolia.base.org --port 8546 --silent &
X402_TEST_EVM_RPC_URL=http://127.0.0.1:8546 mvn -B test
```

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md).

## License

Apache 2.0. See [LICENSE](../LICENSE).
