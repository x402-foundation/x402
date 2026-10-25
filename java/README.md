# x402 Java SDK (v2)

Java implementation of the [x402 protocol](https://github.com/x402-foundation/x402) v2, with a Spring Boot 3 starter. Put `@X402Payment("weather")` on an existing controller method, describe the price in `application.yml`, and the endpoint answers `402 Payment Required` until it is paid.

Cardano `exact` (transfer methods `default`, `masumi` and `script`) is the first mechanism. The layers mirror the TypeScript, Go and Python SDKs.

| Module | What it is |
|---|---|
| `x402-core` | Wire types, the scheme SPI, `X402Client` / `X402ResourceServer` / `X402Facilitator` with hooks, and a framework-free HTTP layer (`X402HttpClient`, `X402HttpResourceServer`, `HttpFacilitatorClient`). No Spring. |
| `x402-mechanism-cardano` | Cardano `exact`: client (transaction builder, wallet signer), server (prices, Masumi quotes) and facilitator (verify, settle). |
| `x402-extensions` | The bazaar discovery declaration (server side). |
| `x402-spring-boot-autoconfigure` | `@X402Payment`, the `x402.*` configuration, WebMvc and WebFlux filters, client interceptors, the facilitator server. |
| `x402-spring-boot-starter` | autoconfigure + core + extensions. Add the mechanisms you use (`x402-mechanism-cardano`, …) next to it. |

The v1 SDK (EVM `exact`, servlet filter) lives unchanged in [`legacy/`](legacy/README.md).

**Status:** `2.0.0-SNAPSHOT`, not on Maven Central yet. Build it locally (Java 17+, Maven 3.9+):

```bash
mvn -f java/pom.xml install -DskipTests
```

Runnable examples: [`examples/java`](../examples/java/README.md).

## Contents

- [Quick start: protect a Spring endpoint](#quick-start-protect-a-spring-endpoint)
- [Prices](#prices)
- [Accounts: networks, wallets, transfer methods](#accounts-networks-wallets-transfer-methods)
- [Several payment options](#several-payment-options)
- [Facilitators](#facilitators)
- [Customizer beans](#customizer-beans)
- [Running it in production](#running-it-in-production)
- [Paying from Java (client)](#paying-from-java-client)
- [Running a facilitator](#running-a-facilitator)
- [Configuration reference](#configuration-reference)
- [Differences from the TypeScript SDK](#differences-from-the-typescript-sdk)

## Quick start: protect a Spring endpoint

**1. Add the starter and the mechanisms you use.** The starter brings no payment mechanism, so you only pull in the chains you accept:

```xml
<dependency>
  <groupId>org.x402</groupId>
  <artifactId>x402-spring-boot-starter</artifactId>
  <version>2.0.0-SNAPSHOT</version>
</dependency>
<dependency>
  <groupId>org.x402</groupId>
  <artifactId>x402-mechanism-cardano</artifactId>
  <version>2.0.0-SNAPSHOT</version>
</dependency>
```

Each mechanism's Spring wiring switches on when its jar is on the classpath. If your configuration names a network whose mechanism is missing (an account on `cardano:preprod` without `x402-mechanism-cardano`, for example), startup fails and names the dependency to add.

**2. Annotate the handler.** The value names an offer under `x402.routes`:

```java
@GetMapping("/weather")
@X402Payment("weather")
Map<String, Object> weather() {
  return Map.of("city", "Lisbon", "weather", "sunny", "temperature", 24);
}
```

**3. Describe the offer** in `application.yml`:

```yaml
x402:
  facilitators:
    - url: "https://your-facilitator.example/x402"   # lists Cardano in /supported
  accounts:
    preprod:                                         # where you get paid
      network: "cardano:preprod"
      pay-to: "${PREPROD_PAY_TO}"
  routes:
    weather:                                         # @X402Payment("weather")
      description: Current weather
      mime-type: application/json
      accepts:
        - { account: preprod, price: "$0.01" }       # 0.01 USDM
```

Unpaid requests get `402` with a `PAYMENT-REQUIRED` header. A request carrying a valid `PAYMENT-SIGNATURE` is verified by the facilitator, runs your handler, is settled, and gets your response plus a `PAYMENT-RESPONSE` header.

What the starter checks at startup:
- Every network that would be wired (accounts and options when `x402.enabled`, `x402.client.cardano.networks` when `x402.client.enabled`, `x402.facilitator-server.cardano.networks` when the facilitator server is enabled) has its mechanism on the classpath. Spellings are matched the way Spring binds them (dashes, camelCase, environment variables).
- `@X402Payment("x")` without `x402.routes.x` fails, listing the known offers.
- On a class, `@X402Payment` covers every handler method; a method-level annotation overrides it. A handler inherited from a shared base controller is priced per controller, so it is paid only where the subclass (or the base method) carries the annotation.
- The offer is taken from the handler Spring actually dispatches to, so a more specific free handler (`/items/free` next to a paid `/items/{id}`) stays free. CORS pre-flight is never charged; `HEAD` on a paid `GET` handler is charged, because Spring runs the handler.
- An offer used by no annotation and no `path:` logs a warning.

**Without an annotation.** An offer with `path:` protects matching requests without touching code. The syntax is the x402 route syntax shared with TS (`*`, `:param`, `[param]`; Spring's `{var}` is rejected). An annotation wins over a `path:` match.

```yaml
x402:
  accounts:
    preprod: { network: "cardano:preprod", pay-to: "${PREPROD_PAY_TO}" }
  routes:
    reports:
      path: "GET /reports/*"
      accepts:
        - { account: preprod, price: "$0.25" }
```

## Prices

`price` takes the same two forms as TS `Price`:

| You write | Means | Wire `amount` / `asset` |
|---|---|---|
| `"$0.50"` | 0.50 of the network's default stablecoin, **1:1, no exchange rate**. On Cardano that is USDM. | `500000` USDM (6 decimals) |
| `"0.50 USDM"`, `"0.50"`, `"0.50 USD"` | the same as `"$0.50"` | `500000` USDM |
| `{ amount: "1500000", asset: lovelace }` | atomic units of any asset | `1500000` lovelace = 1.5 ADA |

There is no `"1.5 ADA"` form: ADA is not a default asset, and TS rejects it too. Write ADA prices in lovelace. Every route lists its options under `accepts`, even a single one.

```yaml
x402:
  accounts:
    preprod: { network: "cardano:preprod", pay-to: "${PREPROD_PAY_TO}" }
    mainnet: { network: "cardano:mainnet", pay-to: "${MAINNET_PAY_TO}" }
  routes:
    report:
      accepts:
        - { account: preprod, price: "$0.50" }                                 # 0.50 USDM
        - { account: preprod, price: { amount: "1500000", asset: lovelace } }  # 1.5 ADA
        - { account: mainnet, price: "0.50 USDM" }                             # ticker form, same as "$0.50"
```

A static price is parsed by the network's scheme at startup, so a bad price fails the app, not the first request. For a price decided per request, name an `X402DynamicPrice` bean with `price-ref` instead of `price` (see [Customizer beans](#customizer-beans)).

**Prices from the environment.** Spring replaces a whole list from a higher-priority source, so an environment variable such as `X402_ROUTES_REPORT_ACCEPTS_0_PRICE` replaces all of `accepts` and startup fails on the incomplete entry. Use a placeholder in the YAML instead, or put the whole list into `SPRING_APPLICATION_JSON` or a profile file:

```yaml
x402:
  accounts:
    preprod: { network: "cardano:preprod", pay-to: "${PREPROD_PAY_TO}" }
  routes:
    report:
      accepts:
        - { account: preprod, price: "${REPORT_PRICE:$0.50}" }
```

Quote `${…}` placeholders inside inline YAML (`{…}`, `[…]`): Spring's YAML parser rejects `{ pay-to: ${PAY_TO} }`. The examples quote CAIP-2 ids there too (`"cardano:preprod"`), which keeps the files valid for YAML 1.1 parsers.

## Accounts: networks, wallets, transfer methods

An **account** says where you get paid: one network, one receiving address, one transfer method. Options reference accounts by name, so the same wallet isn't repeated in every route, and one offer can span networks.

```yaml
x402:
  accounts:
    preprod:                                  # plain transfers on preprod
      network: "cardano:preprod"
      pay-to: "${PREPROD_PAY_TO}"
      cardano:
        l1-confirmations: 1                   # → extra.confirmationPolicy (-1..20; default 1)
    preprod-escrow:                           # Masumi escrow on the same network
      network: "cardano:preprod"
      extra: { assetTransferMethod: masumi }
      # no pay-to: the escrow address of the canonical Masumi deployment is derived
      cardano:
        masumi:
          seller-mnemonic: "${SELLER_MNEMONIC}"   # signs the quotes; a CardanoSellerSigner bean wins
    mainnet:                                  # another network, another wallet
      network: "cardano:mainnet"
      pay-to: "${MAINNET_PAY_TO}"
      max-timeout-seconds: 600
  routes:
    market:
      accepts:
        - { account: preprod, price: "$0.25" }
        - { account: mainnet, price: "$0.25" }
```

Account names match `[a-z0-9-]+` and never reach the wire. Accounts are named, not keyed by network, because Spring strips `:` from map keys and because one network often needs several accounts (plain, escrow, script).

**Resolution order**, per field of each option:

1. **Which account.** An `accepts` entry with `account:` uses it. Without `account:` it is an **inline option** and needs `network` plus `pay-to` (or `pay-to-ref`). Both `account` and `network` on one entry, or neither, fail startup.
2. **Field precedence:** option, then account, then `x402.defaults`, then the built-in default (`scheme: exact`, `max-timeout-seconds: 300`).
3. **`extra`** merges `price.extra`, then the account's, then the option's (the option wins on a clash). `x402.defaults` has no `extra`. An option may not change an `assetTransferMethod` its account sets, so an escrow account cannot lend its address to a plain transfer.
4. **One choice per group.** `pay-to` / `pay-to-ref` is one choice, and so is `price` / `price-ref`: the highest layer that sets either member replaces the whole group. Both members on one layer fail startup.
5. **Offer-level** `network`, `pay-to`, `pay-to-ref`, `extra`, `facilitator`, `scheme`, `max-timeout-seconds`, `price`, `price-ref` and `accounts` fail startup with a hint; they belong on an account or an option.

Cardano rules on top: a Masumi option without `pay-to` gets the escrow address of its deployment (a set `pay-to` must equal it); a plain transfer to an escrow address fails startup (it could never be recovered); an address whose network tag doesn't match the network (`addr_test…` on mainnet) fails startup. `pay-to-ref` receivers get the same checks per request. A Masumi option needs a seller (`cardano.masumi.seller-mnemonic` or a `CardanoSellerSigner` bean) on its network.

**The TS-shaped alternative.** You don't have to use accounts: an inline option carries `network` and `pay-to` itself, exactly like a TS `accepts` entry.

```yaml
x402:
  routes:
    partner:
      accepts:
        - network: "cardano:preprod"
          pay-to: "${PARTNER_PAY_TO}"
          price: "$0.10"
```

Set `extra` keys from YAML or `SPRING_APPLICATION_JSON`, not from plain environment variables: Spring lowercases map keys from the environment, and a lowercased protocol key (`assettransfermethod`) fails startup. Typed fields such as `cardano.l1-confirmations` are safe in the environment.

## Several payment options

An offer is a list of payment options. The buyer picks one; your order states your preference. Options keep their order in `PAYMENT-REQUIRED.accepts`.

```yaml
x402:
  accounts:
    preprod: { network: "cardano:preprod", pay-to: "${PREPROD_PAY_TO}" }
    preprod-escrow:
      network: "cardano:preprod"
      extra: { assetTransferMethod: masumi }
      cardano: { masumi: { seller-mnemonic: "${SELLER_MNEMONIC}" } }
  routes:
    report:
      description: Cardano market report
      accepts:
        - { account: preprod, price: "$0.50" }                                  # 1. USDM
        - { account: preprod, price: { amount: "1500000", asset: lovelace } }   # 2. 1.5 ADA
        - { account: preprod-escrow, price: "$0.50" }                           # 3. USDM via Masumi escrow
```

At startup every option needs a registered scheme, and a facilitator that lists its kind (scheme and network) with a matching transfer method; otherwise startup fails with a `RouteConfigurationError` naming the offer and option index. Two options of one offer that a single payment could match (same core fields, compatible `extra`) but that would be verified differently also fail startup.

Tiers on one endpoint (free versus paid, or plan-based prices) don't use a second annotation: use `price-ref`, or separate endpoints.

## Facilitators

### One facilitator is usually enough

One facilitator can serve many options: it lists every kind it supports in `/supported`. You need a second one only when no single facilitator covers all your options (say Cardano plus another chain later), or as a verify backup.

### The facilitator list

`x402.facilitators` is a list, in precedence order, like the TS array and the Go and Python client lists. With none configured, the one default is `https://x402.org/facilitator`.

```yaml
x402:
  facilitators:
    - url: "https://cardano-facilitator.example/x402"
      identifier: cardano          # optional; default: the url (trailing slashes removed)
      timeout: 90s                 # settle and /supported (default 90s)
      verify-timeout: 15s          # /verify only (default 15s)
      headers:                     # static auth headers per endpoint
        verify: { Authorization: "Bearer ${FACILITATOR_TOKEN}" }
        settle: { Authorization: "Bearer ${FACILITATOR_TOKEN}" }
        supported: { Authorization: "Bearer ${FACILITATOR_TOKEN}" }
    - url: "https://backup-facilitator.example/x402"   # no identifier needed unless you pin it
  sync:
    startup-timeout: 10s           # total budget of the startup /supported check
```

`identifier` is optional (Go `Identifier`, Python `identifier`). It names the facilitator in logs and health details, and pins refer to it. Identifiers, and urls standing in for them, are compared without trailing slashes and must be unique; `local` is reserved for the in-process facilitator. For computed auth headers, name an `X402FacilitatorAuthProvider` bean with `auth-ref`; it replaces `headers` for that entry. There is no single-entry `facilitator:` form.

### Which facilitator handles an option

- **Unpinned** (the default): the first facilitator in list order whose `/supported` lists the option's exact kind. That facilitator builds the requirements, verifies and settles.
- **Pinned**: `facilitator: <identifier>` on the option, the account or `x402.defaults` (option wins, then account, then defaults). Only that facilitator builds, verifies and settles. An unknown identifier, or a pinned facilitator that doesn't list the kind or its transfer method, fails startup.

### Verify failover

With `failover: true` on the offer (or `x402.defaults.failover`), an **unpinned** option whose facilitator fails at transport level retries `/verify` **once** on the next facilitator that lists the identical kind (`extra` included). Transport level means a connection error, a timeout, or HTTP 5xx / 429 without an `isValid` field. A body with `isValid` is final, as is any other 4xx: a second opinion never overrides a rejection. Pinned options never fail over.

**Settle follows the verifier** and never loops: settle and its pending retry go to the facilitator that verified, else the pin, else the option's facilitator. This differs from TS, whose settle loop can move to the next facilitator after a timeout; Java doesn't, to rule out a double broadcast.

```yaml
x402:
  facilitators:
    - url: "${FACILITATOR_URL:http://127.0.0.1:8402/x402}"
      identifier: primary
    - url: "${BACKUP_FACILITATOR_URL:http://127.0.0.1:8403/x402}"
      identifier: backup
  accounts:
    preprod: { network: "cardano:preprod", pay-to: "${PREPROD_PAY_TO}" }
    preprod-escrow:
      network: "cardano:preprod"
      extra: { assetTransferMethod: masumi }
      cardano: { masumi: { seller-mnemonic: "${SELLER_MNEMONIC}" } }
  routes:
    report:
      failover: true                                                     # this offer only
      accepts:
        - { account: preprod, price: "$0.50" }                           # primary; verify may fail over to backup
        - { account: preprod-escrow, price: "$0.50", facilitator: backup }   # pinned: backup only
```

The `multi-facilitator` profile of [`examples/java/servers/spring-boot`](../examples/java/servers/spring-boot/README.md) runs exactly this against two local facilitators.

### Startup sync

At startup the server asks every facilitator for `/supported` in parallel, within `x402.sync.startup-timeout` (total), and applies the answers in list order.

| Case | Result |
|---|---|
| Every facilitator answered and every option is served | Starts; `x402` health `UP`. |
| Every facilitator answered and an option can't be served | Startup fails (TS parity). |
| A facilitator failed or timed out, and only options it might serve are affected | Starts (Java refinement; TS exits). Affected routes answer `503` with `Retry-After` at once; other routes work. A single background re-sync retries with backoff (`x402.sync.initial-backoff` 1s up to `max-backoff` 60s). Health `OUT_OF_SERVICE`. A facilitator that answered before and fails one re-sync keeps its last answer, so its routes keep working. Health shows it `DOWN`, and once every route works the re-sync stops: the kept answer stays until restart (logged). |
| The re-sync answered but options still can't be served | Logged once; affected routes `500 {"error":"x402 route configuration"}`; health `DOWN`; re-sync continues. |
| A facilitator no option needs is down | Not retried; shown `DOWN` in the health details only. The component stays `UP`. |
| No offers at all (e.g. a facilitator-only app) | No sync. |

Errors that no facilitator can heal (no scheme for a network, an unsupported transfer method) always fail startup.

If the facilitator that owns an option changes between a 402 and the payment (after a re-sync), the payment can no longer match the rebuilt requirements and the buyer gets a fresh 402.

### Health and readiness

With Spring Boot Actuator present, the `x402` health component reports `UP`, `OUT_OF_SERVICE` or `DOWN` as above, with each facilitator's state (`UP`, `DOWN` with the error, `NOT_SYNCED`) in its details. Add it to the readiness group so a pod takes traffic only once its offers can be served:

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true
      group:
        readiness:
          include: readinessState, x402
```

### Timeout budget

A paid request waits for at most two verifies (with failover) and one settle plus its pending retry: 2 × 15 s + 2 × 90 s = **210 s** with defaults. The server warns at startup when an option's worst path, computed from its own facilitators' timeouts, exceeds 240 s. `X402HttpClient` gives requests without their own timeout **240 s**. Options using the core `escrow` payment flow settle before and after the handler (4 × settle) and need longer client timeouts; none of the Cardano transfer methods use it (`default`, `masumi` and `script` are all authorization flows).

Keep a facilitator's `timeout` above its settle bound. A Cardano facilitator answers a settle within `settle-timeout` (75 s by default), as long as the chain call in flight at its end returns within `chain-call-reserve` (15 s by default). Its confirmation wait ends with the settle's budget, `settle-timeout` less `chain-call-reserve` (60 s by default) less the time verification and the broadcast took, or earlier at `confirmation-timeout`; without the required evidence by then the answer is `settlement_pending` and the paid retry resumes observing the same transaction. The facilitator server warns at startup when `settle-timeout` exceeds 85 s.

## Customizer beans

YAML covers prices, receivers and facilitators. Everything else is a bean; every auto-configured bean backs off when you define your own (`@ConditionalOnMissingBean`).

| Bean | For |
|---|---|
| `X402ResourceServerCustomizer` | Register schemes and hooks on the resource server (`onBeforeVerify`, `onAfterVerify`, `onVerifyFailure`, `onBeforeSettle`, `onAfterSettle`, `onSettleFailure`, `onVerifiedPaymentCanceled`); `customizeHttp` for `onProtectedRequest` and the paywall. A scheme registered here replaces the auto-registered one for that scheme and network. |
| `X402RouteCustomizer` | Adjust a resolved route: custom 402 bodies, extension declarations. |
| `X402DynamicPrice`, `X402DynamicPayTo` | Per-request price or receiver, referenced by bean name from `price-ref` / `pay-to-ref`. |
| `X402FacilitatorAuthProvider` | Computed facilitator auth headers, referenced from `auth-ref`. |
| `PaywallProvider` | The browser paywall page (without one, a static fallback page). |
| `CardanoSellerSigner`, `X402CardanoNetworkBeans` | Masumi quote signing from a key store or HSM. With several Cardano networks, provide `X402CardanoNetworkBeans` (per network) instead of a single bean. |
| `MasumiTermsStorage` | Where issued Masumi quotes are stored (see [production notes](#running-it-in-production)). |
| `X402ClientCustomizer` | Register client schemes, policies and hooks. |

From [`X402Customizations.java`](../examples/java/servers/spring-boot/src/main/java/org/x402/examples/server/X402Customizations.java):

```java
@Bean
X402ResourceServerCustomizer settlementLog() {
  return server -> server.onAfterSettle(ctx -> LOG.info("settled {} {} on {}: tx {}",
      ctx.requirements().amount(), ctx.requirements().asset(), ctx.requirements().network(),
      ctx.result().transaction()));
}

@Bean
X402DynamicPrice tieredPricer() {
  return request -> "pro".equals(request.header("X-Plan"))
      ? new Money("$0.10")
      : new Money("$0.50");
}
```

```yaml
x402:
  accounts:
    preprod: { network: "cardano:preprod", pay-to: "${PREPROD_PAY_TO}" }
  routes:
    report:
      accepts:
        - { account: preprod, price-ref: tieredPricer }
```

## Running it in production

**Spring Security comes first.** The x402 filter runs right after Spring Security's filter chain, so an unauthenticated request gets `401` before it ever sees a `402`. Change the position with `x402.filter-order`.

**Responses are buffered.** A paid handler's whole response (status, headers, cookies, body) is held until settlement succeeds. If settlement fails the client gets the `402` and none of the handler's headers, so a `Location` or token header cannot leak unpaid. A handler status ≥ 400 or an exception cancels the payment: no settle.

**No streaming on paid handlers.** Handlers returning `SseEmitter`, `ResponseBodyEmitter`, `StreamingResponseBody` or `Flux<ServerSentEvent>`, or declaring a streaming `produces` (`text/event-stream`, NDJSON, `application/stream+json`), also inside `ResponseEntity`, `Mono`, `CompletionStage`, `Callable`, `DeferredResult`, `WebAsyncTask` or `ListenableFuture`, fail startup when their offer settles after the handler, which is every Cardano option. The check reads types and annotations only: a plain `Flux` that Spring decides to stream at request time (on WebMvc a `Flux<String>`, or any `Flux` requested with a streaming `Accept`) is not caught, and is held in memory until it ends. Give a paid `Flux` handler a non-streaming `produces`, such as `application/json`, so a streaming `Accept` gets 406.

**Threads.** The facilitator calls are blocking. A paid request can hold a servlet thread (WebMvc) or a `boundedElastic` worker (WebFlux) for up to the [timeout budget](#timeout-budget), 210 s with defaults. Size your thread pools for it.

**Masumi quotes need shared storage when you scale out.** The default `MasumiTermsStorage` is in memory: correct for one instance only. With several instances behind a load balancer, a quote issued by one instance must be found by the others, and binding a quote to its first payment must be atomic across all of them. Define your own `MasumiTermsStorage` bean (JDBC, Redis) implementing `get(termsDigest)` and an atomic `updateTerms(termsDigest, update)`. If the storage fails, Masumi payments are refused (`masumi_terms_storage_unavailable`), never served unbound.

**Paid handlers only behind the filter.** A dispatch guard answers `500` when a paid handler is reached without the x402 filter having decided its offer, e.g. after a forward or a URL rewrite. So does a test that calls a paid handler through `MockMvc` built **without** filters; `@AutoConfigureMockMvc` adds them by default.

**Paywall.** Browsers (an `Accept: text/html` request with a browser `User-Agent`) get an HTML 402 page. Cardano has no paywall UI yet, so this is a static fallback page; `x402.paywall.enabled=false` keeps every 402 JSON.

**One app, both roles.** An app that is its own facilitator sets `x402.local-facilitator: true` with `x402.facilitator-server.enabled: true`; the in-process facilitator is prepended as `local`. Don't point `x402.facilitators` at the app's own URL: the startup sync runs before the web server listens.

## Paying from Java (client)

### Plain Java: `X402HttpClient`

`X402HttpClient` wraps a `java.net.http.HttpClient`: on a 402 it picks an option, signs, and retries once with `PAYMENT-SIGNATURE`. `X402HttpClient.paymentResponse(response)` decodes the settlement. Condensed from [`JavaHttpClientExample.java`](../examples/java/clients/java-http/src/main/java/org/x402/examples/client/JavaHttpClientExample.java):

```java
MnemonicClientCardanoSigner wallet = new MnemonicClientCardanoSigner(
    ClientCardanoSignerConfig.builder()
        .mnemonic(requireEnv("BUYER_MNEMONIC"))
        .network(NETWORK)
        .walletProvider(blockfrost)
        .build());

SpendControls spendControls = SpendControls.builder()
    .allowedAssets(List.of(new SpendControls.AllowedAsset(NETWORK, "lovelace", MAX_LOVELACE)))
    .maxAmountPerPayment("$1")
    .build();
X402Client client = new X402Client()
    .setSpendControls(spendControls)
    .register(NETWORK, new ExactCardanoClientScheme(wallet));

HttpClient jdk = HttpClient.newBuilder()
    .followRedirects(HttpClient.Redirect.NEVER)
    .connectTimeout(Duration.ofSeconds(10))
    .build();
X402HttpClient http = X402HttpClient.wrap(jdk, client, HostPolicy.of(List.of(url.getHost())));
```

`blockfrost` is a `BlockfrostChainBackend`. The wallet reads its UTxOs and the protocol parameters through cardano-client-lib's `UtxoSupplier` and `ProtocolParamsSupplier` (`.utxoSupplier(...)`, `.protocolParamsSupplier(...)`), so any implementation of those fits; it must throw on a failed read rather than answer a short list, which cardano-client-lib's own `DefaultUtxoSupplier` does not.

- `X402HttpClient.wrap(jdk, client)` without a `HostPolicy` pays any host, like TS `wrapFetch`: wrapping is a deliberate act. With a `HostPolicy`, only those hosts (and only 402s whose `resource.url` is on the list) are paid, and the wrapped client must not follow redirects (`IllegalArgumentException` otherwise): `X402HttpClient` follows them itself and never forwards a signed request to a host off the list.
- A request body is recorded while it is sent, up to 1 MiB (`X402HttpClient.builder(...).maxReplayBody(...)`); a larger body gets its 402 back unpaid.
- Requests without their own timeout get 240 s ([why](#timeout-budget)).
- `java.net.http` has no interceptor API: a client made with `HttpClient.newHttpClient()` cannot be hooked from outside. Wrap the one you use.
- **Back-to-back payments from one wallet.** Blockfrost keeps listing an input until the transaction spending it is on chain. A payment built right after the previous one can pick that input; the facilitator then rejects it at settle, and you get the 402 back with nothing paid. Wait for the previous payment's change output to appear before paying again (the e2e client does this).

### Spend controls

Spend controls are on by default and follow TS: only the network's **default asset** is paid (USDM on Cardano), capped at **$1** per payment. **Lovelace is refused by default.** To pay in ADA, allow it with a cap in lovelace:

```yaml
x402:
  client:
    spend-controls:
      allowed-assets:                         # needed to pay in ADA
        - { network: "cardano:preprod", asset: lovelace, max-amount-per-payment: "2000000" }   # 2 ADA
      max-amount-per-payment: "$1"            # USD cap for USDM (the default)
```

An `allowed-assets` entry **without** `max-amount-per-payment` allows that asset with **no cap**. `allow-any-asset: true` accepts every asset; an asset listed in `allowed-assets` keeps that entry's cap, and every other asset that is not the network's default asset is paid **without any cap**. A `network` pattern such as `cardano:*` also matches `cardano:mainnet`. `enabled: false` turns spend controls off. An empty `max-amount-per-payment` removes the USD cap; the starter logs a warning at startup when you do that. `max-amount-per-payment: false` removes it too, without the warning. In plain Java the same settings are `SpendControls.builder()`, `SpendControls.disabled()` and `X402Client.registerPolicy(...)`.

### Spring: `RestClient`, `RestTemplate`, `WebClient`, `@HttpExchange`

Set `x402.client.enabled: true`. Clients built from Boot's builders (`RestClient.Builder`, `RestTemplateBuilder`, `WebClient.Builder`) then pay, and so do `@HttpExchange` interfaces built on them. Boot's HTTP settings (TLS, proxy, timeouts) are kept.

```yaml
x402:
  client:
    enabled: true
    hosts: ["api.example.com", "*.example.com"]   # only these hosts may charge you
    spend-controls:
      allowed-assets:
        - { network: "cardano:preprod", asset: lovelace, max-amount-per-payment: "2000000" }
    prefer:
      networks: ["cardano:preprod"]
    cardano:
      mnemonic: "${BUYER_MNEMONIC}"
      networks:                                   # one wallet per network
        - network: "cardano:preprod"
          blockfrost: { project-id: "${BLOCKFROST_PREPROD_PROJECT_ID}" }
```

From [`RestClientExampleApplication.java`](../examples/java/clients/spring-rest-client/src/main/java/org/x402/examples/restclient/RestClientExampleApplication.java):

```java
@Bean
PaidApi paidApi(RestClient.Builder builder, @Value("${example.base-url}") String baseUrl) {
  RestClient restClient = builder.baseUrl(baseUrl).build();
  return HttpServiceProxyFactory.builderFor(RestClientAdapter.create(restClient)).build()
      .createClient(PaidApi.class);
}
```

**The host allowlist.** Hooking every Boot-built client would otherwise pay any 402 from any host, up to the spend cap. So `x402.client.hosts` lists the hosts that may trigger a payment: exact hosts (`api.example.com`) or subdomain wildcards (`*.example.com`, which doesn't match `example.com`). Matching ignores case and port. A 402 from any other host, or whose `resource.url` host is off the list, is returned to your code unchanged and nothing is signed. **An empty or absent list means no automatic payment at all**; with `client.enabled: true` that logs a startup warning.

**Not reachable:** `RestClient.create()`, `WebClient.create()` and `new RestTemplate()` outside a bean. A self-built `WebClient` bean is hooked (`x402.client.instrument-beans`, default true). A self-built `RestClient` or `RestTemplate` bean cannot be wrapped afterwards without losing its settings: it is left unchanged and a warning names it. Give it a paying factory when you build it, with the injected `X402ClientHttpRequestFactoryDecorator` bean. From [`SelfBuiltRestClientConfig.java`](../examples/java/clients/spring-rest-client/src/main/java/org/x402/examples/restclient/SelfBuiltRestClientConfig.java):

```java
@Bean
RestClient selfBuiltRestClient(X402ClientHttpRequestFactoryDecorator x402Decorator,
    @Value("${example.base-url}") String baseUrl) {
  HttpClient following = HttpClient.newBuilder()
      .followRedirects(HttpClient.Redirect.NORMAL).build();
  HttpClient notFollowing = HttpClient.newBuilder()
      .followRedirects(HttpClient.Redirect.NEVER).build();
  return RestClient.builder()
      .baseUrl(baseUrl)
      .requestFactory(x402Decorator.decorate(
          new JdkClientHttpRequestFactory(following),
          new JdkClientHttpRequestFactory(notFollowing)))
      .build();
}
```

### Redirects: a paid request never follows one (Spring clients)

With the Spring clients, the request carrying `PAYMENT-SIGNATURE` never follows a redirect on its own; a 3xx answer to it is returned to your code. Otherwise an allowed host could redirect the payment to another origin. One exception keeps an `http://` URL that redirects to `https://` buyable: when the paid request answers with a redirect to the same host over https, and that host passes `x402.client.hosts`, it is re-sent once to the https `Location` with the payment (a 303, or a 301/302 after a POST, becomes a bodyless GET). A second redirect of the paid request then throws an `X402ClientException` naming its `Location`.

Plain `X402HttpClient` pays the URI that answered the 402, with the method and body of the request that was answered (a POST the wrapped client turned into a GET on a 303 is paid as a GET). With a `HostPolicy` it follows redirects itself: the paid request only to hosts on the list, the unpaid one wherever it leads (as the wrapped client would, re-sending a 307/308 body), and it drops `Authorization`, `Cookie`, `Proxy-Authorization`, `X-Api-Key`, `PAYMENT-SIGNATURE` and `X-PAYMENT` when a redirect changes the origin. Without a `HostPolicy` the paid request uses the wrapped client's own redirect setting; build it with `Redirect.NEVER` if the payment must not follow redirects.

`X402HttpClient` holds a response body in memory only while it decides whether to pay: an unpaid 402 carrying `PAYMENT-REQUIRED` from an allowed host, up to 64 KB. If such a 402 is not paid and its body was larger than 64 KB, `send` throws an `IOException` naming the cap instead of returning a cut-off body. The body of a redirect it follows, and of a paid answer your `onPaymentResponse` hook retries, is read and discarded, never held; the request timeout covers the headers only, so a host that never ends such a body holds the call. Any other response streams straight into your `BodyHandler`. The payment hooks run on the thread that called `send`, before the paid answer's body is read.

- **Boot-built clients** follow redirects by default (Boot 3.5). x402 sends the paid request through a twin of the same transport with redirects off, so nothing is needed from you.
- **Self-built blocking clients:** use `x402Decorator.decorate(factory, nonRedirectingFactory)` as above. A paid factory known to follow redirects is refused.
- **x402 fails closed on transports it cannot verify.** The one-argument `decorate(factory)` pays only over a transport proven not to follow redirects (a JDK `HttpClient` with `Redirect.NEVER`, Reactor Netty without `followRedirect`, `SimpleClientHttpRequestFactory`). Over a transport known to follow redirects the payment is refused with an `X402ClientException` before anything is signed; over one it cannot inspect, the 402 is returned unpaid with a warning naming the fix.
- **Self-built `WebClient` beans:** Reactor Netty and JDK connectors are inspected the same way. Other connectors (Jetty, Apache) cannot be checked, so their 402s are returned unpaid with a warning; use a Reactor Netty or JDK connector, or a `WebClient` from Boot's builder.
- The **unpaid** first request follows your transport's settings. If an allowed host redirects it to another host, that host's 402 is trusted only if its `resource.url` host is also allowed. To rule redirects out entirely for Boot-managed clients: `spring.http.client.redirects=dont-follow` and `spring.http.reactiveclient.redirects=dont-follow`.
- The low-level static `X402ClientHttpRequestFactory.wrap(...)` checks nothing: the caller asserts the transport.

### What the paid retry re-sends

- The retry re-sends the request **as prepared by the interceptors and filters before x402**, plus `PAYMENT-SIGNATURE`. They do not run again, so static headers (API keys, bearer tokens) are kept.
- **Interceptors that sign the complete header set** (HTTP message signatures and similar) are **not supported** on paid requests: their signature cannot cover `PAYMENT-SIGNATURE`.
- Request bodies are recorded up to `x402.client.max-replay-body` (default 1MB). A larger body is passed on to the underlying request factory unrecorded (whether it streams depends on that factory) and gets its 402 back unpaid, decided before anything is signed. Requests to hosts outside `x402.client.hosts` are never recorded or paid.

## Running a facilitator

The Java starter includes a facilitator server. With the starter and `x402-mechanism-cardano` on the classpath, this YAML serves `GET /x402/supported`, `POST /x402/verify` and `POST /x402/settle` for Cardano preprod:

```yaml
x402:
  facilitator-server:
    enabled: true                  # independent of x402.enabled
    base-path: /x402               # "" or "/" = root
    cardano:
      accept-mempool: false        # true also accepts l1Confirmations -1 (mempool)
      confirmation-timeout: 75s    # also ends with the settle budget: settle-timeout less chain-call-reserve
      confirmation-poll: 5s
      settle-timeout: 75s          # one whole settle; keep below the resource servers' 90s facilitator timeout
      networks:                    # one facilitator scheme per network
        - network: "cardano:preprod"
          blockfrost: { project-id: "${BLOCKFROST_PREPROD_PROJECT_ID}" }
          mnemonic: "${FACILITATOR_MNEMONIC:}"   # optional: only shows an address in /supported
```

The buyer pays the transaction fee (`areFeesSponsored: false`), so the facilitator holds no funds. The built-in endpoints accept request bodies up to 256 KB and answer `413` beyond, closing the connection; on WebFlux, Reactor Netty still reads and discards the rest of an oversized upload, so cap request sizes at the server or proxy too. It advertises the transfer methods `default`, `masumi` and `script` and the confirmation depths it can check. It logs one line per verify and settle with network, `payTo` and the result. With Spring Boot Actuator, the `x402-facilitator` health component asks each network's backend for its protocol parameters and is `DOWN` when one doesn't answer (`management.health.x402-facilitator.enabled=false` turns it off). Runnable: [`examples/java/facilitator/spring-boot`](../examples/java/facilitator/spring-boot/README.md).

### Protect it with Spring Security

The facilitator server has **no authentication of its own**. An open `/settle` lets anyone relay transactions through your node or Blockfrost quota: that, not funds, is what is exposed. Protect `/verify` and `/settle`, and **exempt the base path from CSRF**: resource servers post without a CSRF token, and Spring Security's default answers those POSTs with `403`. From [`SecurityConfig.java`](../examples/java/facilitator/spring-boot/src/main/java/org/x402/examples/facilitator/SecurityConfig.java):

```java
http.authorizeHttpRequests(auth -> auth
        .requestMatchers(HttpMethod.GET, base + "/supported").permitAll()
        .requestMatchers(base + "/verify", base + "/settle").authenticated()
        .anyRequest().denyAll())
    .httpBasic(Customizer.withDefaults())
    .csrf(csrf -> csrf.ignoringRequestMatchers(base + "/**"));
```

The example's user is built in the same class from `FACILITATOR_PASSWORD` and the facilitator refuses to start without a non-blank password. HTTP Basic sends the password with every request: put TLS between resource servers and the facilitator.

Resource servers then send the credentials per endpoint:

```yaml
x402:
  facilitators:
    - url: "http://127.0.0.1:8402/x402"
      headers:
        verify: { Authorization: "${FACILITATOR_AUTHORIZATION}" }
        settle: { Authorization: "${FACILITATOR_AUTHORIZATION}" }
```

Rate limiting is up to you, too.

### Replays and several instances

- **One transaction pays for one thing.** Settle claims each transaction before broadcasting it, bound to its requirements and resource URL (without the confirmation policy). The same transaction under other requirements or another resource gets `duplicate_settlement`. Verifying a settled transaction again gives `duplicate_settlement`; public verify never accepts a transaction just because it is on chain.
- **A transaction is broadcast at most once.** After verification, the claim passes a broadcast fence; from then on it is never handed to another caller. A retry after `settlement_pending` (same signature, same requirements) resumes observing that transaction and never sends it again. A retry of a settled payment answers success again only after re-reading the ledger evidence at the requested depth: after a rollback it is pending.
- **A settle answers within `settle-timeout` (75 s) as long as the chain call in flight at its end takes at most `chain-call-reserve` (15 s).** Verification, broadcast and the confirmation wait share that budget. Neither the broadcast, an evidence read nor the tip read that decides "expired" starts in the last `chain-call-reserve` (`chainCallReserve` in plain Java; half of `settle-timeout` when that is under 30 s), so the call in flight then can still finish. Past that point the answer is `settlement_pending`; a settle that had not broadcast yet sends nothing, and the retry broadcasts. One chain call can be several Blockfrost requests of up to 10 s each (the request timeout): a submission up to three (the provider check's genesis and tip reads, then the submission), an evidence read up to four (the check, the transaction, then the mempool or the tip). The default reserve covers calls whose requests answer promptly; a provider that is slow on every request can push the answer up to 25 s past `settle-timeout` (100 s with the defaults, past the resource server's 90 s: a 502 there; the retry resumes the broadcast, it never sends it twice). `chain-call-reserve: 40s` makes `settle-timeout` a hard bound, at the cost of a shorter confirmation wait (more `settlement_pending` answers on slow blocks). Verification inside the settle is limited by `lookup-timeout` and the request timeout, not by `settle-timeout`. The confirmation wait ends with the settle's budget (`settle-timeout` less `chain-call-reserve`, 60 s with the defaults, which therefore decide it); a configured `confirmation-timeout` above that budget has no effect (each network's scheme logs a warning). The Blockfrost backend the starter builds does not wait for inclusion inside `submit` (the scheme reads the evidence itself), so a `-1` settle reports `status: mempool`. A `BlockfrostChainBackend` you build yourself waits by default (`awaitConfirmation(true)`), up to its request timeout and outside this budget; build it with `awaitConfirmation(false)` for a facilitator (the scheme logs a warning otherwise).
- **Resuming a broadcast transaction never fails it for a passing reason.** The retry is re-checked. A verdict about the transaction or the retry itself (recipient, amount, asset, signatures, structure, Masumi terms, nonce, payer, version, network) still fails it. A verdict known to depend on the moment (a provider outage, a registry, deployment-approval or allowlist verdict, a protocol-parameter change, the clock) leaves the outcome to the ledger: success once the evidence is there, otherwise pending. Any other verdict (a custom method check's reason, an exception in a validator or an override, a reason this version does not know) is no verdict either way: the resume answers pending, never success or failure, and the paid retry's verify answers `settlement_pending`. When the re-check failed because the provider could not answer, the resume reads the evidence once instead of waiting for it. Without a requirements binding in the store such a verdict stays pending. A paid retry's verify follows the same rule once the ledger or a mempool shows the transaction: with a matching binding it answers valid, so the request goes on to settle, which resumes (never broadcasts again) and lets the ledger decide; without a binding, or before the transaction is seen, it answers `settlement_pending`.
- **An unclear outcome is pending, never failed.** A submission whose outcome is unknown, another settle of the same transaction in progress, or a store that could not record the result answer `settlement_pending`, so the client retries instead of paying again. Only when the backend proves the transaction never left the process (Blockfrost's provider check failed before the request) is the claim released, and the retry broadcasts it.
- **The default claim store is in memory: one instance only.** It holds at most 4096 claims, and keeps broadcast and settled ones until the transaction's validity window has passed (plus 120 s). When it is full and nothing can be evicted, new settles are refused (`capacity-exceeded`, reported as a failed settle). Several facilitator instances need a **shared `SettlementClaimStore` bean** (JDBC, Redis) whose operations are atomic across instances. Implement `claimDetails` and `beginSubmission` too: without them a settled payment is never replayed, and a claim left by a crash after the broadcast stays pending. A store that reclaims stale claims must implement `beginSubmission`, and a delegating store must forward every method.
- **A `SettlementOverrides` amount that varies per request** changes the binding, so a retry of the same payment becomes a duplicate.
- **Use one network name per payment.** The binding covers the network string as sent, so a settle under `cip34:0-1` and its retry under `cardano:preprod` are two bindings: the retry is a duplicate.

### What you can replace

Every bean below backs off when you define your own.

| To change | Use |
|---|---|
| Mempool acceptance, confirmation wait, base path, networks | YAML (above) |
| Policy around verify and settle: allowed payees, audit, rate limits | `X402FacilitatorCustomizer` hooks: `onBeforeVerify` may abort (→ `isValid: false` with your reason), `onBeforeSettle` may abort, the failure hooks may recover |
| Trust in Masumi registry claims or non-canonical escrow deployments | `MasumiRegistryValidator`, `MasumiDeploymentValidator` beans (without them, agent identifiers and custom deployments are refused) |
| The chain provider (own node, Koios, another Blockfrost plan) | a `CardanoChainBackend` bean, or `X402CardanoNetworkBeans.chainBackend(network)` for several networks |
| The duplicate guard across replicas | a `SettlementClaimStore` bean |
| Verification itself, or another scheme or network | `X402FacilitatorCustomizer` → `register(networks, scheme)`; customizers run first, and the Cardano scheme is registered only for networks no customizer claimed. Wrap the auto-built one from `CardanoFacilitatorSchemes.forNetwork(network)`. A replaced scheme is spec-conformant only if it keeps the protocol checks. |
| HTTP: own controllers, paths, auth | `expose-http: false`, then call the `FacilitatorHttpHandler` bean from your controller; it keeps the wire contract |

From [`PayeeAllowlist.java`](../examples/java/facilitator/spring-boot/src/main/java/org/x402/examples/facilitator/PayeeAllowlist.java):

```java
@Bean
@ConditionalOnProperty("example.allowed-pay-to")
X402FacilitatorCustomizer onlyOurSellers(
    @Value("${example.allowed-pay-to}") List<String> allowedPayTo) {
  Predicate<String> allowed = allowedPayTo::contains;
  return facilitator -> facilitator
      .onBeforeVerify(ctx -> allowed.test(ctx.requirements().payTo())
          ? HookResults.Decision.proceed()
          : HookResults.Decision.abort("payee_not_allowed"))
      .onBeforeSettle(ctx -> allowed.test(ctx.requirements().payTo())
          ? HookResults.Decision.proceed()
          : HookResults.Decision.abort("payee_not_allowed"));
}
```

A policy hook belongs on **both** `onBeforeVerify` and `onBeforeSettle`: a caller can post to `/settle` without verifying first. For Masumi options `payTo` is the escrow address, and the canonical deployment's escrow address is shared by every Masumi seller, so allowing it admits all of them; telling sellers apart needs a hook that reads the seller from the escrow datum.

## Configuration reference

Every key with its default is in one file: [`application-reference.yml`](../examples/java/servers/spring-boot/src/main/resources/application-reference.yml). A test binds it through the SDK's properties classes, so it cannot drift. `*` stands for a name you choose, `[]` for a list element.

Free-form values (`extra`, extensions) are bound as maps, and Spring Boot binds a YAML list as a map with keys `0`, `1`, …. The SDK turns such a map back into a list everywhere in these values, so a JSON object whose keys are exactly `0..n-1` cannot be written in YAML. Spring Boot's loader also binds an empty list `[]` as the empty string and drops an empty map `{}` before the SDK sees them, indistinguishable from `""` and from no key. Set any of these through a customizer bean.

**Resource server**

| Key | Default | Meaning |
|---|---|---|
| `x402.enabled` | `true` | `false` turns off the resource server and the client. |
| `x402.facilitators[].url` | `https://x402.org/facilitator` (when the list is empty) | Facilitator base URL. |
| `x402.facilitators[].identifier` | the url | Name for logs, health and pins. `local` is reserved. |
| `x402.facilitators[].timeout` | `90s` | Settle and `/supported`. |
| `x402.facilitators[].verify-timeout` | `15s` | `/verify`. |
| `x402.facilitators[].headers.verify` / `.settle` / `.supported` | | Static headers per endpoint. |
| `x402.facilitators[].auth-ref` | | Bean name of an `X402FacilitatorAuthProvider`; replaces `headers`. |
| `x402.sync.startup-timeout` | `10s` | Total budget of the startup `/supported` check. |
| `x402.sync.initial-backoff` / `max-backoff` | `1s` / `60s` | Background re-sync backoff. |
| `x402.accounts.*.network` | | CAIP-2 network, required. |
| `x402.accounts.*.pay-to` / `pay-to-ref` | | Receiving address, or bean name of an `X402DynamicPayTo`. |
| `x402.accounts.*.scheme` | `x402.defaults.scheme` | |
| `x402.accounts.*.max-timeout-seconds` | `x402.defaults.max-timeout-seconds` | |
| `x402.accounts.*.extra` | | Scheme data merged under each option's `extra`. |
| `x402.accounts.*.facilitator` | | Pins the account's options. |
| `x402.accounts.*.cardano.l1-confirmations` | `1` (TS default, not written) | `-1..20`, becomes `extra.confirmationPolicy`. |
| `x402.accounts.*.cardano.masumi.seller-mnemonic` | | Signs Masumi quotes on the network. |
| `x402.accounts.*.cardano.masumi.seller-return-address` | | Optional payout address in quotes. |
| `x402.accounts.*.cardano.masumi.agent-identifier` | | Optional Masumi registry asset id. |
| `x402.accounts.*.cardano.masumi.deployment.{required-admins, admin-vkeys, cooldown-period}` | canonical deployment | A non-canonical escrow deployment; required on Preview. |
| `x402.defaults.scheme` | `exact` | |
| `x402.defaults.max-timeout-seconds` | `300` | |
| `x402.defaults.failover` | `false` | Verify failover for unpinned options. |
| `x402.defaults.facilitator` | | Default pin. |
| `x402.routes.*.accepts[]` | | The payment options (`account`, `network`, `scheme`, `pay-to`, `pay-to-ref`, `price`, `price-ref`, `max-timeout-seconds`, `extra`, `facilitator`). |
| `x402.routes.*.accepts[].price` | | `"$0.50"`, `"0.50 USDM"`, or `{amount, asset, extra}`. |
| `x402.routes.*.path` | | x402 route pattern protecting requests without an annotation. |
| `x402.routes.*.description` / `mime-type` / `service-name` / `tags` / `icon-url` | | Route metadata in `PAYMENT-REQUIRED`. |
| `x402.routes.*.resource` | the request URL | Fixed resource URL. |
| `x402.routes.*.custom-paywall-html` | | Fixed HTML 402 page for browsers. |
| `x402.routes.*.failover` | `x402.defaults.failover` | |
| `x402.routes.*.extensions` | | Extension declarations, e.g. `bazaar: { discoverable: true }`. |
| `x402.paywall.enabled` | `true` | `false` = every 402 is JSON. |
| `x402.paywall.app-name` / `app-logo` / `testnet` | | Paywall page settings. |
| `x402.filter-order` | right after Spring Security | Position of the x402 filter. |
| `x402.local-facilitator` | `false` | Use the in-process facilitator (needs `x402.facilitator-server.enabled`). |

**Client**

| Key | Default | Meaning |
|---|---|---|
| `x402.client.enabled` | `false` | Hook Boot-built clients. |
| `x402.client.hosts` | empty = no payment | Hosts allowed to charge you. |
| `x402.client.instrument-beans` | `true` | Hook self-built `WebClient` beans; warn about self-built `RestClient` / `RestTemplate` beans. |
| `x402.client.max-replay-body` | `1MB` | Largest request body that can be re-sent with payment. |
| `x402.client.spend-controls.enabled` | `true` | |
| `x402.client.spend-controls.max-amount-per-payment` | `"$1"` | USD cap for default assets; empty (warns) or `false` = no cap. |
| `x402.client.spend-controls.allow-any-asset` | `false` | `true` pays any asset; `allowed-assets` caps still apply, other non-default assets have no cap. |
| `x402.client.spend-controls.allowed-assets[].{network, asset, max-amount-per-payment}` | | Extra allowed assets; cap in atomic units. **No cap when `max-amount-per-payment` is left out.** A `network` pattern like `cardano:*` includes mainnet. |
| `x402.client.prefer.networks` / `schemes` | | Preferred first; first entry wins. |
| `x402.client.cardano.mnemonic` | | Buyer mnemonic for every network below. |
| `x402.client.cardano.networks[].{network, mnemonic, blockfrost.project-id, blockfrost.base-url}` | base URL per network | One wallet per network. |

**Facilitator server**

| Key | Default | Meaning |
|---|---|---|
| `x402.facilitator-server.enabled` | `false` | |
| `x402.facilitator-server.expose-http` | `true` | `false` = in-process only. |
| `x402.facilitator-server.base-path` | `/x402` | |
| `x402.facilitator-server.cardano.accept-mempool` | `false` | |
| `x402.facilitator-server.cardano.confirmation-timeout` | `75s` | Also ends with the settle's budget (`settle-timeout` less `chain-call-reserve`, 60 s by default, which therefore decides with the defaults); a configured value above that budget has no effect and is logged. |
| `x402.facilitator-server.cardano.confirmation-poll` | `5s` | |
| `x402.facilitator-server.cardano.settle-timeout` | `75s` | Bound on one whole settle, as long as the chain call in flight at its end takes at most `chain-call-reserve`. No broadcast or evidence read starts in its last `chain-call-reserve`; past that the answer is `settlement_pending`. Warns above 85 s. |
| `x402.facilitator-server.cardano.chain-call-reserve` | `15s` (half of `settle-timeout` under 30 s) | The end part of `settle-timeout` kept for the chain call in flight; must be shorter than `settle-timeout`. A Blockfrost evidence read is up to four requests of up to 10 s: `40s` makes `settle-timeout` a hard bound, at the cost of a shorter confirmation wait. |
| `x402.facilitator-server.cardano.max-tip-age` | `5m` | Chain reads are refused when the provider's latest block is older (or more than 30 s ahead). |
| `x402.facilitator-server.cardano.lookup-timeout` | `10s` | Budget for the chain lookups of one verification. |
| `x402.facilitator-server.cardano.max-input-lookups` | `64` | A transaction with more inputs is a lookup failure before any lookup. |
| `x402.facilitator-server.cardano.max-tx-bytes` | `65536` | The largest transaction verify accepts; the protocol's `maxTxSize` lowers it further. |
| `x402.facilitator-server.cardano.script-datum-policy` | `reference` | `reference` refuses only a Plutus V1 inline datum; `strict` needs the datum kind each Plutus version can spend; `v3-optional` also lets Plutus V3 go without one. |
| `x402.facilitator-server.cardano.networks[].{network, blockfrost.project-id, blockfrost.base-url, mnemonic}` | base URL per network | One facilitator scheme per network. A CIP-34 alias configures its canonical network; naming one network twice fails startup. |
| `x402.facilitator-server.cardano.networks[].network-magic` | `764824073`, `1`, `2` | The genesis magic the provider must report. |
| `x402.facilitator-server.cardano.networks[].slot-config.{zero-time, zero-slot, slot-length}` | built in | Private networks; all three together. |
| `x402.facilitator-server.cardano.networks[].evaluation` | `true` | `false` for a provider without transaction evaluation (yaci-store): verify skips the dry-run. |
| `x402.facilitator-server.cardano.networks[].masumi-allowed-script-hashes` | empty | When set, Masumi escrows not on the list are refused (the canonical one included), and listed custom deployments need no `MasumiDeploymentValidator`. |

`x402.routes.*.extensions.bazaar` accepts `discoverable`, `method`, `input`, `input-schema`, `path-params`, `path-params-schema`, `body-type` and `output.{example, schema}`.

## Differences from the TypeScript SDK

The wire format (headers, JSON, status codes, route syntax) follows TS. Behaviour differs here, on purpose:

| Topic | TS | Java |
|---|---|---|
| Facilitator down at startup | the app exits | starts; only affected routes answer 503 while a background re-sync runs; a facilitator that answered before keeps its last answer through a failed re-sync |
| Pinning an option to a facilitator, verify failover | not available | available (server-side only, invisible on the wire) |
| Settle after a facilitator error | may move on to the next facilitator | never; settle goes to the verifier |
| Facilitator HTTP server | hand-written in each example | `x402.facilitator-server.*` |
| Already-settled Cardano transaction sent again | public verify accepts it once it is on chain | verify: `duplicate_settlement`; settle with the same requirements and resource: success again after re-reading the evidence; otherwise `duplicate_settlement` |
| Cardano submission with an unknown outcome (transport error, wrong hash echoed) | `exact_cardano_settlement_failed` | `settlement_pending`; the retry resumes and never rebroadcasts |
| Second settle of a transaction already being settled | `duplicate_settlement` | `settlement_pending` |
| Retry of a broadcast payment, verify | ledger evidence alone counts | needs ledger or mempool evidence, then re-checks recipient, amount, asset and the payer recorded at broadcast; the nonce owner must have signed. A re-check that fails for the moment (a provider or registry outage, a protocol-parameter change, the clock), possibly before the recipient, amount and payer checks ran, answers valid when the claim is bound to these exact requirements and resource (the pre-broadcast verification passed them) and a payer is known; settle then lets the ledger decide. Without a binding, or for any other failed re-check (a custom check's reason, an exception), it answers `settlement_pending` |
| "Expired" answer for a pending settlement | wall clock past the TTL | only once the provider's latest block is past the TTL and a successful read shows the transaction absent |
| Definitive Cardano rejection | provider error text | only an HTTP 400 whose every ledger rule is decided by the transaction itself; `BadInputsUTxO` never is |
| Blockfrost provider on another network or with a stale tip | used | refused before any read or submission |
| `payTo`, change outputs, aux data, required signers, body fields, size | not checked | `payTo` and every output on the requirements' network, min-UTxO on every output, required signers witnessed, only plain-payment body fields without a full validator, protocol `maxTxSize`, auxiliary data committed and metadata-only, `maxTimeoutSeconds > 0` |
| Facilitator request body | unbounded | nesting 64, strings 200 000, numbers 1000 digits |
| Masumi terms storage fails | the payment proceeds | the payment is refused |
| Cardano transaction without a TTL | accepted | refused (`ttl_too_far`): `maxTimeoutSeconds` cannot bound it, and its claim could never expire |
| Cardano input not signed by its owner | accepted by verify (the node rejects it later) | refused (`phase1_invalid`); script-, Byron- or unknown-owned inputs need a complete phase-1 validator |
| Cardano settlement record after broadcast | evicted once the store needs room | kept until the transaction's TTL has passed, so it cannot be settled twice from the mempool; only an unconfirmed submission (no success reported) may give way under pressure |
| Blockfrost evidence for another transaction (hash differs or missing), without a block height, or with an unreadable chain tip | counted as included (0 confirmations) | a lookup failure: never a success, the settlement stays pending |
| Cardano transaction with a repeated CBOR map key (including a repeated policy id or asset name, also when one copy is chunked) | the last value wins | refused (`transaction_decode_failed`) |
| Cardano map-form transaction output with a key other than 0–3 | accepted (e.g. 4 or 9) | refused (`transaction_decode_failed`): the ledger CDDL defines only keys 0–3 |
| Redirect to another origin | headers are forwarded | `Authorization`, `Cookie`, `PAYMENT-SIGNATURE` and similar credentials are dropped by `X402HttpClient` with a `HostPolicy`, and between the request and the URI that answered the 402 without one (the paid request then follows the wrapped client's redirect setting); the Spring clients never follow a redirect of a paid request except one same-host http→https upgrade |
| Facilitator client and redirects | follows them (`fetch`) | never follows them; a 3xx from the facilitator is an error |
| Facilitator capability mismatch (transfer method, `l1Confirmations` range) or an invalid option (confirmation policy, Masumi schema) | every request to the route fails | startup: a transfer method or confirmation range the facilitator does not advertise is a `FACILITATOR_CAPABILITY` error; an invalid confirmation policy or Masumi schema is an `INVALID_OPTION` error from `SchemeNetworkServer.validateOption`, fatal and never retried (it does not depend on the facilitator). Both check the option's `extra` and a static price's `extra`; a dynamic price is still checked per request |
| One Cardano settle | the confirmation wait alone is bounded (75 s) | the whole settle is bounded (`settle-timeout`, 75 s; no chain call starts in the last `chain-call-reserve`, 15 s), so it fits the resource server's 90 s timeout unless the chain call in flight then takes more than 30 s (a Blockfrost evidence read is up to four 10 s requests; `chain-call-reserve: 40s` makes the bound hard) |
| Resuming a broadcast Cardano transaction whose re-check fails | only a lookup failure stays pending | any verdict known to depend on the moment (provider, registry, deployment approval, allowlist, protocol parameters, clock) leaves the outcome to the ledger; verify of the paid retry answers valid when the claim is bound to the same requirements, else `settlement_pending`. Any other failed re-check (a custom check's reason, an exception) answers `settlement_pending`, never success or failure |
| Masumi quote with an `agentIdentifier`, paid by the SDK client | the signer gets no resource | the signer gets the 402's resource |
| Masumi template on a route that also accepts another Cardano network | the first template is issued by whichever option runs first (can break the mutation policy) | each option issues only its own template |
| Masumi allowlist refusal | `invalid_exact_cardano_payload_masumi_contract_mismatch` | same (Java spelled it `..._requirements_...` before) |
| Client `resource.url` missing or off the allowlist | not checked | the 402 is returned unpaid |
| Facilitator unreachable or timing out | 402 | 502 (no receipt) |
| Handler headers after a failed settle | kept | dropped (the whole paid response is buffered) |
| Client host allowlist | none (you wrap one `fetch`) | `x402.client.hosts` / `HostPolicy` |
| Declarative config | code only | `application.yml`, named accounts |

Not implemented yet: other chains, MCP, client-side extensions, the payment-identifier, sign-in-with-x and builder-code extensions, the bazaar facilitator client, a Cardano paywall UI, and a non-Spring servlet filter (v1 in [`legacy/`](legacy/README.md) has one). See [SDK features](../docs/sdk-features.md).
