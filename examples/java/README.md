# x402 Java examples

Runnable examples for the [Java SDK](../../java/README.md) (v2), on Cardano preprod. Each is a standalone Maven project depending on the SDK's `2.0.0-SNAPSHOT` artifacts, so install the SDK first:

```bash
mvn -f java/pom.xml install -DskipTests
```

| Example | Role | What it shows |
|---|---|---|
| [`servers/spring-boot`](servers/spring-boot/README.md) | resource server | `@X402Payment` + `application.yml`: one single-option offer, one offer with USDM, ADA and Masumi options, named accounts; profiles `multi-facilitator` (two facilitators, a pin, verify failover) and `mainnet` (one offer on two networks); `application-reference.yml` with every key |
| [`clients/java-http`](clients/java-http/README.md) | client | plain `X402HttpClient` (`java.net.http`, no Spring), spend controls with ADA allowed, a host policy |
| [`clients/spring-rest-client`](clients/spring-rest-client/README.md) | client | `x402.client.*` YAML, an `@HttpExchange` interface on Boot's `RestClient.Builder`, a self-built `RestClient` with `decorate(factory, nonRedirectingFactory)` |
| [`facilitator/spring-boot`](facilitator/spring-boot/README.md) | facilitator | a Cardano facilitator from YAML, protected with Spring Security |

Each example builds and tests on its own, without touching a chain:

```bash
mvn -f examples/java/servers/spring-boot/pom.xml verify
mvn -f examples/java/clients/java-http/pom.xml verify
mvn -f examples/java/clients/spring-rest-client/pom.xml verify
mvn -f examples/java/facilitator/spring-boot/pom.xml verify
```

The end-to-end walkthrough (facilitator, server, paying client on preprod) is in the [server example](servers/spring-boot/README.md#walkthrough-preprod).
