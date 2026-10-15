package org.x402.examples.client;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.client.PaymentPolicy;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.http.HostPolicy;
import org.x402.http.X402HttpClient;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.exact.client.ExactCardanoClientScheme;
import org.x402.mechanisms.cardano.signer.ClientCardanoSignerConfig;
import org.x402.mechanisms.cardano.signer.MnemonicClientCardanoSigner;

/**
 * Pays an x402 endpoint on Cardano preprod with plain {@code java.net.http}: no Spring.
 *
 * <p>Environment: {@code BUYER_MNEMONIC} and {@code BLOCKFROST_PREPROD_PROJECT_ID} (required),
 * {@code PAY_WITH=ada} to prefer an ADA option over USDM. The first argument is the URL (default
 * {@code http://127.0.0.1:8080/weather}).
 */
public final class JavaHttpClientExample {

  static final String NETWORK = "cardano:preprod";

  /** Pay at most 2 ADA per request in lovelace; spend controls refuse lovelace otherwise. */
  static final String MAX_LOVELACE = "2000000";

  private JavaHttpClientExample() {}

  public static void main(String[] args) throws Exception {
    URI url = URI.create(args.length > 0 ? args[0] : "http://127.0.0.1:8080/weather");

    // 1. A wallet: the buyer's mnemonic, with Blockfrost for UTxO lookups.
    BlockfrostChainBackend blockfrost = new BlockfrostChainBackend(
        BlockfrostChainBackend.Config.builder()
            .network(NETWORK)
            .projectId(requireEnv("BLOCKFROST_PREPROD_PROJECT_ID"))
            .build());
    MnemonicClientCardanoSigner wallet = new MnemonicClientCardanoSigner(
        ClientCardanoSignerConfig.builder()
            .mnemonic(requireEnv("BUYER_MNEMONIC"))
            .network(NETWORK)
            .walletProvider(blockfrost)
            .build());

    // 2. The payment client: Cardano exact scheme, spend controls, optional ADA preference.
    boolean preferAda = "ada".equalsIgnoreCase(System.getenv("PAY_WITH"));
    X402Client payments = paymentClient(new ExactCardanoClientScheme(wallet), preferAda);

    // 3. A java.net.http client that pays 402s from this one host.
    try (X402HttpClient http = payingHttpClient(payments, url)) {
      HttpResponse<String> response = http.send(HttpRequest.newBuilder(url).GET().build(),
          HttpResponse.BodyHandlers.ofString());
      System.out.println("HTTP " + response.statusCode());
      System.out.println(response.body());
      Optional<SettleResponse> settled = X402HttpClient.paymentResponse(response);
      settled.ifPresent(s -> System.out.println("paid: success=" + s.success()
          + " transaction=" + s.transaction() + " network=" + s.network()));
    }
  }

  /**
   * The payment client.
   *
   * <p>Spend controls are on by default: only the network's default asset (USDM on
   * Cardano) is paid, capped at $1 per payment, and <b>lovelace is refused</b>. To pay in ADA,
   * list it under {@code allowedAssets} with a cap in lovelace.
   *
   * @param scheme the Cardano client scheme (with the buyer's wallet)
   * @param preferAda whether to move ADA options to the front
   * @return the client
   */
  static X402Client paymentClient(SchemeNetworkClient scheme, boolean preferAda) {
    SpendControls spendControls = SpendControls.builder()
        .allowedAssets(List.of(new SpendControls.AllowedAsset(NETWORK, "lovelace", MAX_LOVELACE)))
        .maxAmountPerPayment("$1")                  // USD cap for USDM ("$1" = 1 USDM)
        .build();
    X402Client client = new X402Client()
        .setSpendControls(spendControls)
        .register(NETWORK, scheme);
    if (preferAda) {
      client.registerPolicy(preferAsset("lovelace"));
    }
    return client;
  }

  /**
   * Wraps a JDK client so it pays 402s. With a {@link HostPolicy}, only the listed hosts can
   * trigger a payment, and the delegate must not follow redirects: {@link X402HttpClient}
   * follows them itself and never forwards a signed request to a host off the list.
   *
   * @param payments the payment client
   * @param url the URL whose host may charge
   * @return the paying client
   */
  static X402HttpClient payingHttpClient(X402Client payments, URI url) {
    HttpClient jdk = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(10))
        .build();
    // Requests without their own timeout get 240 s: a paid request can take up to 210 s on the
    // server (two verifies at 15 s, a settle and its pending retry at 90 s each).
    return X402HttpClient.wrap(jdk, payments, HostPolicy.of(List.of(url.getHost())));
  }

  /** A policy moving options in {@code asset} to the front, keeping the others as fallback. */
  static PaymentPolicy preferAsset(String asset) {
    return (version, options) -> {
      List<PaymentRequirements> sorted = new ArrayList<>();
      options.stream().filter(o -> asset.equals(o.asset())).forEach(sorted::add);
      options.stream().filter(o -> !asset.equals(o.asset())).forEach(sorted::add);
      return sorted;
    };
  }

  private static String requireEnv(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      throw new IllegalStateException(name + " is required");
    }
    return value.strip();
  }
}
