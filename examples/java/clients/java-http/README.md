# x402 plain Java client example (`java.net.http`)

Pays an x402 endpoint on Cardano preprod with `X402HttpClient`, a `java.net.http.HttpClient` that answers 402s by paying and retrying once. No Spring.

The code is [`JavaHttpClientExample.java`](src/main/java/org/x402/examples/client/JavaHttpClientExample.java):

1. **A wallet:** `MnemonicClientCardanoSigner` from the buyer's mnemonic, with Blockfrost for UTxO lookups.
2. **A payment client:** `X402Client` with the Cardano `exact` scheme registered for `cardano:preprod` only, so it never pays on mainnet.
3. **Spend controls:** on by default, they pay only USDM, at most $1 per payment, and refuse lovelace. The example allows lovelace up to 2 ADA:

   ```java
   SpendControls spendControls = SpendControls.builder()
       .allowedAssets(List.of(new SpendControls.AllowedAsset(NETWORK, "lovelace", MAX_LOVELACE)))
       .maxAmountPerPayment("$1")                  // USD cap for USDM ("$1" = 1 USDM)
       .build();
   ```

4. **A host policy:** only the host of the URL you call may charge you. With a `HostPolicy` the wrapped JDK client must not follow redirects; `X402HttpClient` follows them itself and never forwards a signed request to another host.

   ```java
   HttpClient jdk = HttpClient.newBuilder()
       .followRedirects(HttpClient.Redirect.NEVER)
       .connectTimeout(Duration.ofSeconds(10))
       .build();
   return X402HttpClient.wrap(jdk, payments, HostPolicy.of(List.of(url.getHost())));
   ```

5. `X402HttpClient.paymentResponse(response)` decodes the settlement (`PAYMENT-RESPONSE`).

## Run it

Against the [server example](../../servers/spring-boot/README.md) on port 8080, from the repository root:

```bash
mvn -f java/pom.xml install -DskipTests          # once: the SDK isn't on Maven Central yet
export BUYER_MNEMONIC="word1 word2 ... word24"   # a funded preprod wallet
export BLOCKFROST_PREPROD_PROJECT_ID=preprod...
mvn -q -f examples/java/clients/java-http/pom.xml compile exec:java \
  -Dexec.args=http://127.0.0.1:8080/weather
# HTTP 200
# {"city":"Lisbon","weather":"sunny","temperature":24}
# paid: success=true transaction=... network=cardano:preprod
```

`PAY_WITH=ada` prefers an ADA option (e.g. on `/report`) through a small payment policy; the wallet then needs tADA only.

Requests get a 240 s timeout unless they set their own: a paid request can take up to 210 s on the server (two verifies, a settle and its pending retry).

Paying twice in a row from one wallet: wait until the first payment is on chain (usually under a minute on preprod). Before that, Blockfrost still lists the input it spent, the next payment may reuse it, and the facilitator rejects it at settle; you get the 402 back and nothing is paid.

## Tests

```bash
mvn -f examples/java/clients/java-http/pom.xml verify
```

The tests run the example's client wiring against a WireMock resource server with a recording scheme in place of the wallet: a USDM offer is paid, `PAY_WITH=ada` picks lovelace within its cap, and lovelace above the cap is never signed.
