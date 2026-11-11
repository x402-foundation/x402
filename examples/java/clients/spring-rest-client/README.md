# x402 Spring client example (`RestClient`, `@HttpExchange`)

A Spring Boot command-line app that pays x402 endpoints on Cardano preprod. The code is plain Spring; x402 comes from the starter, the `x402-mechanism-cardano` dependency and [`application.yml`](src/main/resources/application.yml).

## The configuration

```yaml
spring:
  main:
    web-application-type: none    # a command-line app
  http:
    client:
      redirects: dont-follow      # optional: the first (unpaid) request doesn't follow redirects
                                  # either; the paid retry never does, whatever this says

example:
  base-url: "${RESOURCE_SERVER_URL:http://127.0.0.1:8080}"   # servers/spring-boot
  endpoint: "${ENDPOINT:weather}"                            # weather or report

x402:
  client:
    enabled: true
    hosts: ["127.0.0.1", "localhost"]   # only these hosts may charge you; empty = no payments
    spend-controls:
      allowed-assets:             # lovelace is refused unless listed here (cap in lovelace)
        - { network: "cardano:preprod", asset: lovelace, max-amount-per-payment: "2000000" }
      max-amount-per-payment: "$1"   # USD cap for USDM, the default ("$1" = 1 USDM)
    prefer:
      networks: ["cardano:preprod"]
    cardano:
      mnemonic: "${BUYER_MNEMONIC}"
      networks:                   # one wallet per network; only these networks are paid
        - network: "cardano:preprod"
          blockfrost: { project-id: "${BLOCKFROST_PREPROD_PROJECT_ID}" }
```

## The code

[`PaidApi`](src/main/java/org/x402/examples/restclient/PaidApi.java) is an ordinary `@HttpExchange` interface. The proxy sits on a `RestClient` built from Boot's `RestClient.Builder`, which is what carries x402 ([`RestClientExampleApplication`](src/main/java/org/x402/examples/restclient/RestClientExampleApplication.java)):

```java
@Bean
PaidApi paidApi(RestClient.Builder builder, @Value("${example.base-url}") String baseUrl) {
  RestClient restClient = builder.baseUrl(baseUrl).build();
  return HttpServiceProxyFactory.builderFor(RestClientAdapter.create(restClient)).build()
      .createClient(PaidApi.class);
}
```

`RestClient.create()` would **not** pay. A `RestClient` bean you build yourself gets a warning and stays unpaid, unless you give it a paying factory when you build it: [`SelfBuiltRestClientConfig`](src/main/java/org/x402/examples/restclient/SelfBuiltRestClientConfig.java) uses the injected `X402ClientHttpRequestFactoryDecorator` with `decorate(factory, nonRedirectingFactory)`, so the paid request goes through the twin that never follows redirects.

`RestTemplateBuilder` and `WebClient.Builder` work the same way as `RestClient.Builder`.

## Run it

Against the [server example](../../servers/spring-boot/README.md) on port 8080, from the repository root:

```bash
mvn -f java/pom.xml install -DskipTests          # once: the SDK isn't on Maven Central yet
export BUYER_MNEMONIC="word1 word2 ... word24"   # a funded preprod wallet
export BLOCKFROST_PREPROD_PROJECT_ID=preprod...
ENDPOINT=report mvn -q -f examples/java/clients/spring-rest-client/pom.xml spring-boot:run
# HTTP 200 {title=Cardano market report, ...}
# paid: success=true transaction=... network=cardano:preprod
```

On `/report` it pays the first option the spend controls allow, 0.50 USDM, so the wallet needs preprod USDM. To prefer ADA, register a payment policy in an `X402ClientCustomizer` bean, as the [plain Java client](../java-http/README.md) does with `PAY_WITH=ada`.

## Tests

```bash
mvn -f examples/java/clients/spring-rest-client/pom.xml verify
```

The tests load this `application.yml` against a WireMock resource server, with a recording scheme in place of the wallet: the `@HttpExchange` interface pays a USDM offer, the self-built `RestClient` pays too, lovelace is paid within its cap and never signed above it.
