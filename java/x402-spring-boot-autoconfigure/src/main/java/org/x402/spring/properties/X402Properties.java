package org.x402.spring.properties;

import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;
import org.x402.http.HttpFacilitatorClient;

/**
 * The x402.* configuration. Unknown fields are ignored, because mechanism auto-configurations
 * bind their own blocks (e.g. x402.accounts.*.cardano) over the same prefix; fields that are not
 * allowed in a place are detected separately and fail startup.
 *
 * @param enabled whether the resource server and the client are active (default true)
 * @param facilitators the facilitators, in precedence order; none = https://x402.org/facilitator
 * @param sync startup and background /supported sync
 * @param accounts where you get paid: one entry per network, receiver and transfer method
 * @param defaults network-independent defaults for every payment option
 * @param routes the offers, by name (@X402Payment("<name>"))
 * @param paywall the browser paywall
 * @param client the payment client for outgoing requests
 * @param filterOrder the order of the x402 filter (default: right after Spring Security)
 * @param localFacilitator use the in-process facilitator (needs x402.facilitator-server.enabled)
 */
@ConfigurationProperties("x402")
public record X402Properties(
    @DefaultValue("true") boolean enabled,
    List<Facilitator> facilitators,
    @DefaultValue Sync sync,
    Map<String, Account> accounts,
    @DefaultValue Defaults defaults,
    Map<String, Offer> routes,
    @DefaultValue Paywall paywall,
    @DefaultValue Client client,
    Integer filterOrder,
    boolean localFacilitator) {

  /** Normalizes absent collections to empty ones, keeping declaration order. */
  public X402Properties {
    facilitators = facilitators == null ? List.of() : List.copyOf(facilitators);
    accounts = accounts == null ? Map.of()
        : Collections.unmodifiableMap(new LinkedHashMap<>(accounts));
    routes = routes == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(routes));
  }

  /**
   * The configured facilitators, or the one default entry when none is configured.
   *
   * @return the facilitators in precedence order
   */
  public List<Facilitator> effectiveFacilitators() {
    if (!facilitators.isEmpty()) {
      return facilitators;
    }
    return List.of(new Facilitator(HttpFacilitatorClient.DEFAULT_URL, null,
        HttpFacilitatorClient.DEFAULT_TIMEOUT, HttpFacilitatorClient.DEFAULT_VERIFY_TIMEOUT,
        new FacilitatorHeaders(null, null, null), null));
  }

  /**
   * One facilitator entry of the facilitator list.
   *
   * @param url the base URL
   * @param identifier the name used in logs, health and pins; defaults to the URL
   * @param timeout settle and /supported timeout (default 90 s)
   * @param verifyTimeout /verify timeout (default 15 s)
   * @param headers static auth headers per endpoint
   * @param authRef the bean name of an X402FacilitatorAuthProvider; replaces headers
   */
  public record Facilitator(
      String url,
      String identifier,
      @DefaultValue("90s") Duration timeout,
      @DefaultValue("15s") Duration verifyTimeout,
      @DefaultValue FacilitatorHeaders headers,
      String authRef) {

    /**
     * The effective identifier: identifier, else url, without trailing slashes.
     *
     * @return the identifier, or null when neither is set
     */
    public String effectiveIdentifier() {
      return normalize(identifier != null && !identifier.isBlank() ? identifier : url);
    }

    /**
     * Removes trailing slashes, as pins and identifiers are compared.
     *
     * @param value the value, may be null
     * @return the normalized value
     */
    public static String normalize(String value) {
      if (value == null) {
        return null;
      }
      String v = value.strip();
      int end = v.length();
      while (end > 1 && v.charAt(end - 1) == '/') {
        end--;
      }
      return v.substring(0, end);
    }
  }

  /**
   * Static headers per facilitator endpoint.
   *
   * @param verify headers for POST /verify
   * @param settle headers for POST /settle
   * @param supported headers for GET /supported
   */
  public record FacilitatorHeaders(
      Map<String, String> verify, Map<String, String> settle, Map<String, String> supported) {}

  /**
   * Facilitator sync.
   *
   * @param startupTimeout total budget of the synchronous startup sync (default 10 s)
   * @param initialBackoff first delay of the background re-sync (default 1 s)
   * @param maxBackoff longest delay between background re-syncs (default 60 s)
   */
  public record Sync(
      @DefaultValue("10s") Duration startupTimeout,
      @DefaultValue("1s") Duration initialBackoff,
      @DefaultValue("60s") Duration maxBackoff) {}

  /**
   * Where you get paid. Mechanism blocks such as cardano are bound by the
   * mechanism's own auto-configuration.
   *
   * @param network the CAIP-2 network (required)
   * @param payTo the receiving address
   * @param payToRef the bean name of an X402DynamicPayTo
   * @param scheme the scheme, else x402.defaults.scheme
   * @param maxTimeoutSeconds the payment timeout, else x402.defaults.max-timeout-seconds
   * @param extra scheme data merged under each option's extra
   * @param facilitator pins every option of this account to a facilitator identifier
   */
  public record Account(
      String network,
      String payTo,
      String payToRef,
      String scheme,
      Integer maxTimeoutSeconds,
      Map<String, Object> extra,
      String facilitator) {}

  /**
   * Network-independent defaults.
   *
   * @param scheme the scheme (default exact)
   * @param maxTimeoutSeconds the payment timeout (default 300)
   * @param failover verify failover for unpinned options (default false)
   * @param facilitator a default pin
   */
  public record Defaults(
      @DefaultValue("exact") String scheme,
      @DefaultValue("300") int maxTimeoutSeconds,
      @DefaultValue("false") boolean failover,
      String facilitator) {}

  /**
   * One offer: route metadata plus its payment options.
   *
   * @param path an x402 route pattern protecting matching requests without an annotation
   * @param description the resource description
   * @param mimeType the response MIME type
   * @param resource a fixed resource URL (default: the request URL)
   * @param serviceName the service name
   * @param tags discovery tags
   * @param iconUrl the icon URL
   * @param customPaywallHtml a fixed paywall page
   * @param failover verify failover; absent inherits x402.defaults.failover
   * @param accepts the payment options, in order of preference
   * @param extensions extension declarations, e.g. bazaar
   */
  public record Offer(
      String path,
      String description,
      String mimeType,
      String resource,
      String serviceName,
      List<String> tags,
      String iconUrl,
      String customPaywallHtml,
      Boolean failover,
      List<Accept> accepts,
      Map<String, Object> extensions) {

    /** Normalizes an absent list. */
    public Offer {
      accepts = accepts == null ? List.of() : List.copyOf(accepts);
    }
  }

  /**
   * One payment option (accepts[] entry).
   *
   * @param account the account supplying network and receiver
   * @param network the network of an inline option (no account)
   * @param scheme the scheme
   * @param payTo the receiving address
   * @param payToRef the bean name of an X402DynamicPayTo
   * @param price a money string ("$0.50", "0.50 USDM") or {@code {amount, asset,
   *     extra}}
   * @param priceRef the bean name of an X402DynamicPrice
   * @param maxTimeoutSeconds the payment timeout
   * @param extra scheme data; wins over the account's
   * @param facilitator pins the option to a facilitator identifier
   */
  public record Accept(
      String account,
      String network,
      String scheme,
      String payTo,
      String payToRef,
      PriceSpec price,
      String priceRef,
      Integer maxTimeoutSeconds,
      Map<String, Object> extra,
      String facilitator) {}

  /**
   * The browser paywall.
   *
   * @param enabled serve HTML 402s to browsers (default true)
   * @param appName the application name shown on the paywall
   * @param appLogo the logo URL
   * @param testnet whether to show testnets
   */
  public record Paywall(
      @DefaultValue("true") boolean enabled, String appName, String appLogo, Boolean testnet) {}

  /**
   * The payment client for outgoing requests.
   *
   * @param enabled hook Boot-built clients (default false)
   * @param spendControls spend limits
   * @param prefer preferred networks and schemes, first entry most preferred
   * @param hosts hosts allowed to trigger a payment (api.example.com, *.example.com); empty = none
   * @param instrumentBeans hook self-built WebClient beans and warn about self-built
   *     RestClient / RestTemplate beans (default true)
   * @param maxReplayBody largest request body that can be re-sent with payment (default 1 MB)
   */
  public record Client(
      boolean enabled,
      @DefaultValue SpendControlsProperties spendControls,
      @DefaultValue Prefer prefer,
      List<String> hosts,
      @DefaultValue("true") boolean instrumentBeans,
      @DefaultValue("1MB") DataSize maxReplayBody) {

    /** Normalizes an absent list. */
    public Client {
      hosts = hosts == null ? List.of() : List.copyOf(hosts);
    }
  }

  /**
   * Client spend controls: caps on what the client may pay.
   *
   * @param enabled false = no spend controls (default true)
   * @param maxAmountPerPayment USD cap for default assets (default "$1")
   * @param allowAnyAsset allow assets other than the network's default asset
   * @param allowedAssets extra allowed assets
   */
  public record SpendControlsProperties(
      @DefaultValue("true") boolean enabled,
      @DefaultValue("$1") String maxAmountPerPayment,
      boolean allowAnyAsset,
      List<AllowedAsset> allowedAssets) {

    /** Normalizes an absent list. */
    public SpendControlsProperties {
      allowedAssets = allowedAssets == null ? List.of() : List.copyOf(allowedAssets);
    }
  }

  /**
   * An allowed non-default asset.
   *
   * @param network a network or pattern
   * @param asset the asset identifier
   * @param maxAmountPerPayment a cap in atomic units
   */
  public record AllowedAsset(String network, String asset, String maxAmountPerPayment) {}

  /**
   * Preferences; the first entry wins.
   *
   * @param networks preferred networks
   * @param schemes preferred schemes
   */
  public record Prefer(List<String> networks, List<String> schemes) {

    /** Normalizes absent lists. */
    public Prefer {
      networks = networks == null ? List.of() : List.copyOf(networks);
      schemes = schemes == null ? List.of() : List.copyOf(schemes);
    }
  }
}
