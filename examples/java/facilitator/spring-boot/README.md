# x402 Spring Boot facilitator example (Cardano)

A Cardano x402 facilitator from YAML: `GET /x402/supported`, `POST /x402/verify`, `POST /x402/settle`, served by the starter's facilitator server. Resource servers of any SDK (TypeScript, Go, Python, Java) can use it.

## The configuration

```yaml
x402:
  facilitator-server:
    enabled: true
    base-path: /x402
    cardano:
      confirmation-timeout: 75s   # the default; keep it below the resource servers' 90s timeout
      networks:                   # one facilitator scheme per network
        - network: "cardano:preprod"
          blockfrost:
            project-id: "${BLOCKFROST_PREPROD_PROJECT_ID}"
            base-url: "${BLOCKFROST_PREPROD_URL:}"   # empty = Blockfrost's preprod URL
          # Optional: a mnemonic only shows the facilitator's address in /supported.
          # The buyer pays the fees; the facilitator needs no funds.
          mnemonic: "${FACILITATOR_MNEMONIC:}"
```

Besides `main` there are two classes. [`SecurityConfig.java`](src/main/java/org/x402/examples/facilitator/SecurityConfig.java): the facilitator server has no authentication of its own, so `/verify` and `/settle` require HTTP Basic, `/supported` stays public, and the base path is exempt from CSRF (resource servers post without a CSRF token; Spring Security's default would answer 403). The user is `FACILITATOR_USER` (default `x402`) with `FACILITATOR_PASSWORD`; without a non-blank password the facilitator does not start. HTTP Basic sends the password with every request, so put TLS between resource servers and the facilitator anywhere but `localhost`. An open `/settle` would let anyone relay transactions through your Blockfrost quota; the facilitator holds no funds.

## Run it

```bash
mvn -f java/pom.xml install -DskipTests          # once: the SDK isn't on Maven Central yet
export BLOCKFROST_PREPROD_PROJECT_ID=preprod...
export FACILITATOR_PASSWORD=change-me            # HTTP Basic user x402 (FACILITATOR_USER to change)
mvn -f examples/java/facilitator/spring-boot/pom.xml spring-boot:run
curl -s http://127.0.0.1:8402/x402/supported
# {"kinds":[{"x402Version":2,"scheme":"exact","network":"cardano:preprod",
#   "extra":{"assetTransferMethods":["default","masumi","script"],"areFeesSponsored":false,...}}],...}
```

Resource servers authenticate with `Authorization: Basic base64(x402:<password>)` on `/verify` and `/settle`, e.g. through `x402.facilitators[].headers` in the [server example](../../servers/spring-boot/README.md). A second instance for the server's `multi-facilitator` profile: `-Dspring-boot.run.arguments=--server.port=8403`.

## Optional: accept only your own sellers

[`LifecycleHooks.java`](src/main/java/org/x402/examples/facilitator/LifecycleHooks.java) registers all six lifecycle hooks (before/after verify, verify failure, before/after settle, settle failure). Each logs one line such as `before verify: cardano:preprod pay 1500000 lovelace to addr_test1...`; replace the log lines with your own code. A before-hook can refuse with `Decision.abort(reason)`, a failure hook can answer with `Recovery.recovered(response)`.

[`PayeeAllowlist.java`](src/main/java/org/x402/examples/facilitator/PayeeAllowlist.java) adds an `onBeforeVerify` and an `onBeforeSettle` hook when `example.allowed-pay-to` is set: payments to other addresses get `isValid: false` from `/verify` and `success: false` from `/settle`, both with reason `payee_not_allowed`, before the chain is asked. The settle hook matters because a caller can post to `/settle` without verifying first. For Masumi the `payTo` is the escrow address, which the canonical deployment shares among **all** Masumi sellers: listing it admits every Masumi seller. Telling sellers apart needs a hook that reads the seller from the escrow datum.

```yaml
example:
  allowed-pay-to: "addr_test1...seller,addr_test1...escrow"   # for Masumi the payTo is the escrow address
```

## Before you run it for others

- **One instance only, as configured.** The duplicate-settlement guard keeps its claims in memory: at most 4096, each kept until its transaction's validity window has passed plus 120 s. When it is full and nothing can be evicted, new settles are refused (`capacity-exceeded`). For production and behind a load balancer, provide a shared `SettlementClaimStore` bean (JDBC, Redis) so two instances can't both accept one in-flight transaction. A transaction this facilitator reported as settled is never accepted again, by verify or settle.
- **Rate limits** are yours to add, like authentication.
- **Health.** Add `spring-boot-starter-actuator` to get the `x402-facilitator` health component (one backend probe per network), and allow its path in `SecurityConfig`, which denies everything it doesn't name.
- Everything you can replace (hooks, Masumi validators, chain backend, claim store, schemes, own controllers) is listed in the [Java SDK README](../../../../java/README.md#running-a-facilitator).

## Tests

```bash
mvn -f examples/java/facilitator/spring-boot/pom.xml verify
```

The tests start the app with a Blockfrost URL on a closed local port: `/supported` answers without login, `/verify` and `/settle` need it, an authenticated POST passes without a CSRF token, and the payee allowlist refuses other addresses. No chain is contacted.
