# x402 Spring Boot server example

A Spring Boot app whose endpoints are paid on Cardano preprod. The Java side is ordinary Spring plus one annotation per paid endpoint; the offers and prices live in [`application.yml`](src/main/resources/application.yml).

| Endpoint | Offer | Payment options |
|---|---|---|
| `GET /free` | none | free |
| `GET /weather` | `weather` | 0.01 USDM |
| `GET /report` | `report` | 0.50 USDM, or 1.5 ADA, or 0.50 USDM via Masumi escrow |
| `GET /market` (profile `mainnet`) | `market` | 0.25 USDM on preprod, or 0.25 USDM on mainnet |

## The code

```java
@GetMapping("/weather")
@X402Payment("weather")
Map<String, Object> weather() {
  return Map.of("city", "Lisbon", "weather", "sunny", "temperature", 24);
}
```

## The configuration

```yaml
x402:
  facilitators:
    # examples/java/facilitator/spring-boot, started locally. Any x402 facilitator that lists Cardano works.
    - url: "${FACILITATOR_URL:http://127.0.0.1:8402/x402}"
      headers:
        # The example facilitator protects /verify and /settle with HTTP Basic (Spring Security).
        verify: { Authorization: "${FACILITATOR_AUTHORIZATION:}" }
        settle: { Authorization: "${FACILITATOR_AUTHORIZATION:}" }

  accounts:                       # where you get paid; options reference these names
    preprod:                      # plain transfers to your wallet
      network: "cardano:preprod"
      pay-to: "${PREPROD_PAY_TO}"
    preprod-escrow:               # Masumi escrow on the same network
      network: "cardano:preprod"
      extra: { assetTransferMethod: masumi }
      # no pay-to: the escrow address of the canonical Masumi deployment is derived
      cardano:
        masumi:
          seller-mnemonic: "${SELLER_MNEMONIC}"   # signs the Masumi quotes

  routes:
    weather:                      # @X402Payment("weather")
      description: Current weather
      mime-type: application/json
      accepts:
        # "$" = the network's default stablecoin at 1:1, no exchange rate: USDM on Cardano.
        # "$0.01" = 0.01 USDM = amount 10000 (6 decimals). "0.01 USDM" means the same.
        - { account: preprod, price: "$0.01" }

    report:                       # @X402Payment("report"); the buyer picks one option
      description: Cardano market report
      mime-type: application/json
      accepts:                    # your order of preference
        - { account: preprod, price: "$0.50" }                                  # 0.50 USDM
        - { account: preprod, price: { amount: "1500000", asset: lovelace } }   # 1.5 ADA, in lovelace
        - { account: preprod-escrow, price: "$0.50" }                           # 0.50 USDM via Masumi escrow
```

Every `x402.*` key, with its default, is in [`application-reference.yml`](src/main/resources/application-reference.yml). The [Java SDK README](../../../../java/README.md) explains each part.

## Walkthrough (preprod)

You need Java 17+, Maven, a [Blockfrost](https://blockfrost.io) preprod project id, and two preprod wallets: one to get paid (any address you control) and a funded buyer wallet (tADA from the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet); `/weather` and the first `/report` option also need preprod USDM). Commands run from the repository root.

**1. Install the SDK** (it isn't on Maven Central yet):

```bash
mvn -f java/pom.xml install -DskipTests
```

**2. Start the facilitator** on port 8402 (see [`examples/java/facilitator/spring-boot`](../../facilitator/spring-boot/README.md)):

```bash
export BLOCKFROST_PREPROD_PROJECT_ID=preprod...
export FACILITATOR_PASSWORD=change-me
mvn -f examples/java/facilitator/spring-boot/pom.xml spring-boot:run
```

**3. Start this server** on port 8080, in a second terminal:

```bash
export PREPROD_PAY_TO=addr_test1...            # your wallet
export SELLER_MNEMONIC="word1 word2 ... word24"  # signs Masumi quotes; any preprod mnemonic you own
export FACILITATOR_AUTHORIZATION="Basic $(printf 'x402:%s' change-me | base64)"
mvn -f examples/java/servers/spring-boot/pom.xml spring-boot:run
```

**4. Ask without paying:**

```bash
curl -i http://127.0.0.1:8080/weather
# HTTP/1.1 402
# PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi...
curl -s -D - -o /dev/null http://127.0.0.1:8080/report | grep -i payment-required \
  | cut -d' ' -f2 | tr -d '\r' | base64 --decode
```

The decoded header lists the three options of `report`, in YAML order, with `amount` in atomic units and the asset id of USDM or `lovelace`.

**5. Pay** with the [plain Java client](../../clients/java-http/README.md), in a third terminal:

```bash
export BUYER_MNEMONIC="word1 word2 ... word24"
export BLOCKFROST_PREPROD_PROJECT_ID=preprod...
PAY_WITH=ada mvn -q -f examples/java/clients/java-http/pom.xml compile exec:java \
  -Dexec.args=http://127.0.0.1:8080/report
# HTTP 200
# {"title":"Cardano market report",...}
# paid: success=true transaction=... network=cardano:preprod
```

`PAY_WITH=ada` makes the client prefer the 1.5 ADA option; without it the client pays the first option it may pay, 0.50 USDM. The server logs `settled 1500000 lovelace on cardano:preprod: tx …` from the customizer in [`X402Customizations.java`](src/main/java/org/x402/examples/server/X402Customizations.java).

## Profile `multi-facilitator`: two facilitators, a pin, verify failover

[`application-multi-facilitator.yml`](src/main/resources/application-multi-facilitator.yml) lists two facilitators by identifier, pins the Masumi option to the second, and turns on verify failover for `report`:

```yaml
x402:
  facilitators:                   # replaces the list of application.yml; order = precedence
    - url: "${FACILITATOR_URL:http://127.0.0.1:8402/x402}"
      identifier: primary         # optional name for logs, health and pins (default: the url)
      headers:
        verify: { Authorization: "${FACILITATOR_AUTHORIZATION:}" }
        settle: { Authorization: "${FACILITATOR_AUTHORIZATION:}" }
    - url: "${BACKUP_FACILITATOR_URL:http://127.0.0.1:8403/x402}"
      identifier: backup
      verify-timeout: 10s         # /verify only; settle and /supported use timeout (90s)
      headers:
        verify: { Authorization: "${FACILITATOR_AUTHORIZATION:}" }
        settle: { Authorization: "${FACILITATOR_AUTHORIZATION:}" }

  routes:
    report:
      failover: true              # unpinned options may verify on the next facilitator (one hop)
      accepts:                    # replaces the list of application.yml
        - { account: preprod, price: "$0.50" }                                  # unpinned: primary, else backup
        - { account: preprod, price: { amount: "1500000", asset: lovelace } }   # unpinned
        - { account: preprod-escrow, price: "$0.50", facilitator: backup }      # pinned: only backup, never fails over
```

Run a second facilitator on port 8403 and start the server with the profile:

```bash
mvn -f examples/java/facilitator/spring-boot/pom.xml spring-boot:run -Dspring-boot.run.arguments=--server.port=8403
mvn -f examples/java/servers/spring-boot/pom.xml spring-boot:run -Dspring-boot.run.profiles=multi-facilitator
curl -s http://127.0.0.1:8080/actuator/health/x402
# {"status":"UP","details":{"facilitators":{"primary":{"status":"UP"},"backup":{"status":"UP"}},...}}
```

Stop the primary facilitator and pay `/report` again: verify fails over to `backup`, and settle goes to `backup` too (settle always follows the verifier). The profile also puts `x402` into the readiness group (`/actuator/health/readiness`).

What happens when a facilitator is down at startup, and how the routes behave meanwhile, is in the [startup sync table](../../../../java/README.md#startup-sync).

## Profile `mainnet`: one offer on two networks

```yaml
x402:
  accounts:                       # merged with the accounts of application.yml
    mainnet:
      network: "cardano:mainnet"
      pay-to: "${MAINNET_PAY_TO}"
  routes:
    market:                       # @X402Payment("market") on MarketController (this profile only)
      description: Market data
      mime-type: application/json
      accepts:
        - { account: preprod, price: "$0.25" }   # 0.25 USDM on preprod
        - { account: mainnet, price: "$0.25" }   # 0.25 USDM on mainnet, to the mainnet wallet
```

The facilitator must list `cardano:mainnet` too, otherwise startup fails (the option could never be verified). Mainnet is real money: the examples' clients only pay on preprod.

## Tests

```bash
mvn -f examples/java/servers/spring-boot/pom.xml verify
```

`ExampleProfilesSmokeTest` starts the default, `multi-facilitator` and `mainnet` profiles against WireMock facilitators (402 unpaid, 200 paid, failover to the backup), binds `application-reference.yml` through the SDK's properties classes, and parses every YAML block of the Java READMEs. Nothing touches a chain.
