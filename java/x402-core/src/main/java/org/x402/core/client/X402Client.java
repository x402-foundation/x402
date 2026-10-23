package org.x402.core.client;

import java.math.BigInteger;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import org.x402.core.PaymentFlow;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.SchemeNetworkClient.DefaultAsset;
import org.x402.core.SchemeNetworkClient.PaymentPayloadContext;
import org.x402.core.SchemeNetworkClient.PaymentPayloadResult;
import org.x402.core.client.ClientHooks.AfterPaymentCreationHook;
import org.x402.core.client.ClientHooks.BeforePaymentCreationHook;
import org.x402.core.client.ClientHooks.OnPaymentCreationFailureHook;
import org.x402.core.client.ClientHooks.OnPaymentResponseHook;
import org.x402.core.client.ClientHooks.PaymentCreatedContext;
import org.x402.core.client.ClientHooks.PaymentCreationContext;
import org.x402.core.client.ClientHooks.PaymentCreationFailureContext;
import org.x402.core.client.ClientHooks.PaymentResponseContext;
import org.x402.core.client.ClientHooks.SchemeClientHooks;
import org.x402.core.hooks.HookResults.Abort;
import org.x402.core.hooks.HookResults.Recovered;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.utils.Amounts;
import org.x402.core.utils.JsonValues;
import org.x402.core.utils.Networks;

/**
 * The paying side: picks one of a 402's options and asks the
 * matching scheme to sign it.
 *
 * <p>Selection runs in order: (1) keep options with a registered network + scheme, (2)
 * drop unknown {@code paymentFlow} values, (3) spend controls, (4) policies in registration order
 * (an empty result throws), (5) prefer authorization flows, (6) the selector (default: first).
 *
 * <p>Spend controls are on by default ({@link SpendControls#defaults()}): only default assets, at
 * most {@code $1} per payment. Thread-safe; configure before use.
 */
public final class X402Client {

  private static final int X402_VERSION = 2;
  private static final Set<String> FLOWS = Set.of(PaymentFlow.AUTHORIZATION.wire(),
      PaymentFlow.UPFRONT.wire(), PaymentFlow.ESCROW.wire());

  private final PaymentRequirementsSelector selector;
  /** network → scheme → client, replaced whole on each registration (protocol version 2). */
  private volatile Map<String, Map<String, SchemeNetworkClient>> registered = Map.of();
  private final List<PaymentPolicy> policies = new CopyOnWriteArrayList<>();
  private volatile SpendControls spendControls = SpendControls.defaults();
  private final List<BeforePaymentCreationHook> beforeHooks = new CopyOnWriteArrayList<>();
  private final List<AfterPaymentCreationHook> afterHooks = new CopyOnWriteArrayList<>();
  private final List<OnPaymentCreationFailureHook> failureHooks = new CopyOnWriteArrayList<>();
  private final List<OnPaymentResponseHook> responseHooks = new CopyOnWriteArrayList<>();

  /** Creates a client that picks the first remaining option. */
  public X402Client() {
    this((version, reqs) -> reqs.get(0));
  }

  /**
   * Creates a client with a custom selector.
   *
   * @param selector picks the final option
   */
  public X402Client(PaymentRequirementsSelector selector) {
    this.selector = Objects.requireNonNull(selector, "selector");
  }

  /**
   * Registers a scheme for a network or pattern such as {@code cardano:*}; the same network and
   * scheme replace an earlier registration.
   *
   * @param network the network or pattern
   * @param client the scheme
   * @return this client
   */
  public synchronized X402Client register(String network, SchemeNetworkClient client) {
    Map<String, Map<String, SchemeNetworkClient>> next = new LinkedHashMap<>(registered);
    Map<String, SchemeNetworkClient> schemes =
        new LinkedHashMap<>(next.getOrDefault(network, Map.of()));
    schemes.put(client.scheme(), client);
    next.put(network, Collections.unmodifiableMap(schemes));
    registered = Collections.unmodifiableMap(next);
    return this;
  }

  /**
   * Adds a policy; policies run in registration order after spend controls.
   *
   * @param policy the policy
   * @return this client
   */
  public X402Client registerPolicy(PaymentPolicy policy) {
    policies.add(Objects.requireNonNull(policy, "policy"));
    return this;
  }

  /**
   * Replaces the spend controls.
   *
   * @param controls the controls; {@link SpendControls#disabled()} turns them off
   * @return this client
   */
  public X402Client setSpendControls(SpendControls controls) {
    this.spendControls = Objects.requireNonNull(controls, "controls");
    return this;
  }

  /**
   * The spend controls in force.
   *
   * @return the controls
   */
  public SpendControls spendControls() {
    return spendControls;
  }

  /**
   * Adds a hook before a payment is created; it may abort.
   *
   * @param hook the hook
   * @return this client
   */
  public X402Client onBeforePaymentCreation(BeforePaymentCreationHook hook) {
    beforeHooks.add(hook);
    return this;
  }

  /**
   * Adds a hook after a payment was created.
   *
   * @param hook the hook
   * @return this client
   */
  public X402Client onAfterPaymentCreation(AfterPaymentCreationHook hook) {
    afterHooks.add(hook);
    return this;
  }

  /**
   * Adds a hook when payment creation fails; it may recover with a payload.
   *
   * @param hook the hook
   * @return this client
   */
  public X402Client onPaymentCreationFailure(OnPaymentCreationFailureHook hook) {
    failureHooks.add(hook);
    return this;
  }

  /**
   * Adds a hook for the server's answer to a paid request.
   *
   * @param hook the hook; returning {@code true} asks the transport to pay once more
   * @return this client
   */
  public X402Client onPaymentResponse(OnPaymentResponseHook hook) {
    responseHooks.add(hook);
    return this;
  }

  /**
   * Runs the payment-response hooks (manual, then the scheme's) until one recovers.
   *
   * @param context the response
   * @return {@code true} when a hook recovered
   */
  public boolean handlePaymentResponse(PaymentResponseContext context) {
    for (OnPaymentResponseHook hook : hooks(responseHooks, SchemeClientHooks::onPaymentResponse,
        context.paymentPayload().x402Version(), context.requirements())) {
      if (hook.apply(context)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Selects an option and creates a signed payment for it.
   *
   * @param paymentRequired the server's 402
   * @return the payment
   * @throws X402ClientException when nothing is acceptable or a hook aborts
   */
  public PaymentPayload createPaymentPayload(PaymentRequired paymentRequired) {
    int version = paymentRequired.x402Version();
    Map<String, Map<String, SchemeNetworkClient>> byNetwork = byNetwork(version);
    PaymentRequirements selected = selectPaymentRequirements(version, paymentRequired.accepts());
    PaymentCreationContext context = new PaymentCreationContext(paymentRequired, selected);
    for (BeforePaymentCreationHook hook : hooks(beforeHooks,
        SchemeClientHooks::onBeforePaymentCreation, version, selected)) {
      if (hook.apply(context) instanceof Abort a) {
        throw new X402ClientException("Payment creation aborted: " + a.reason());
      }
    }
    try {
      SchemeNetworkClient scheme =
          Networks.findByNetworkAndScheme(byNetwork, selected.scheme(), selected.network());
      if (scheme == null) {
        throw new X402ClientException("No client registered for scheme: " + selected.scheme()
            + " and network: " + selected.network());
      }
      String cap = resolveAtomicCap(spendControls, selected,
          scheme.findDefaultAsset(selected.asset(), selected.network()));
      PaymentPayloadResult partial = scheme.createPaymentPayload(version, selected,
          new PaymentPayloadContext(paymentRequired.extensions(), cap, paymentRequired.resource()));
      PaymentPayload payload = new PaymentPayload(partial.x402Version(),
          paymentRequired.resource(), selected, partial.payload(),
          mergeExtensions(paymentRequired.extensions(), partial.extensions()));
      PaymentCreatedContext created =
          new PaymentCreatedContext(paymentRequired, selected, payload);
      for (AfterPaymentCreationHook hook : hooks(afterHooks,
          SchemeClientHooks::onAfterPaymentCreation, version, selected)) {
        hook.apply(created);
      }
      return payload;
    } catch (RuntimeException error) {
      PaymentCreationFailureContext failure =
          new PaymentCreationFailureContext(paymentRequired, selected, error);
      for (OnPaymentCreationFailureHook hook : hooks(failureHooks,
          SchemeClientHooks::onPaymentCreationFailure, version, selected)) {
        Recovery<PaymentPayload> recovery = hook.apply(failure);
        if (recovery instanceof Recovered<PaymentPayload> r) {
          return r.value();
        }
      }
      throw error;
    }
  }

  /**
   * Runs the selection pipeline described on the class.
   *
   * @param x402Version the protocol version
   * @param requirements the server's options
   * @return the chosen option
   * @throws X402ClientException when every option is filtered out
   */
  public PaymentRequirements selectPaymentRequirements(
      int x402Version, List<PaymentRequirements> requirements) {
    Map<String, Map<String, SchemeNetworkClient>> byNetwork = byNetwork(x402Version);
    List<PaymentRequirements> supported = requirements.stream().filter(r -> {
      Map<String, SchemeNetworkClient> forNetwork =
          Networks.findSchemesByNetwork(byNetwork, r.network());
      return forNetwork != null && forNetwork.containsKey(r.scheme());
    }).toList();
    if (supported.isEmpty()) {
      Map<String, Object> detail = new LinkedHashMap<>();
      detail.put("x402Version", x402Version);
      detail.put("paymentRequirements", requirements);
      detail.put("x402Versions", registered.isEmpty() ? List.of() : List.of(X402_VERSION));
      detail.put("networks", List.copyOf(byNetwork.keySet()));
      throw new X402ClientException("No network/scheme registered for x402 version: "
          + x402Version + " which comply with the payment requirements. "
          + X402Json.write(detail));
    }
    List<PaymentRequirements> recognized = supported.stream()
        .filter(r -> {
          Object flow = r.extra().get("paymentFlow");
          return flow == null || FLOWS.contains(String.valueOf(flow));
        }).toList();
    if (recognized.isEmpty()) {
      throw new X402ClientException(
          "No payment requirements with a recognized paymentFlow for x402 version: "
              + x402Version);
    }
    List<PaymentRequirements> filtered = applySpendControls(x402Version, recognized, byNetwork);
    for (PaymentPolicy policy : policies) {
      filtered = policy.apply(x402Version, filtered);
      if (filtered.isEmpty()) {
        throw new X402ClientException(
            "All payment requirements were filtered out by policies for x402 version: "
                + x402Version);
      }
    }
    List<PaymentRequirements> authorization = filtered.stream().filter(r -> {
      Object flow = r.extra().get("paymentFlow");
      return flow == null || PaymentFlow.AUTHORIZATION.wire().equals(flow);
    }).toList();
    if (!authorization.isEmpty()) {
      filtered = authorization;
    }
    return selector.select(x402Version, filtered);
  }

  /**
   * Whether a client scheme is registered for a network (protocol version 2), matching exact keys
   * first and then patterns such as {@code cardano:*}, exactly like payment selection does.
   *
   * @param network the CAIP-2 network
   * @param scheme the scheme name
   * @return {@code true} when a payment on that network and scheme could be created
   */
  public boolean hasRegisteredScheme(String network, String scheme) {
    return Networks.findByNetworkAndScheme(registered, scheme, network) != null;
  }

  private Map<String, Map<String, SchemeNetworkClient>> byNetwork(int x402Version) {
    Map<String, Map<String, SchemeNetworkClient>> byNetwork = registered;
    if (x402Version != X402_VERSION || byNetwork.isEmpty()) {
      throw new X402ClientException("No client registered for x402 version: " + x402Version);
    }
    return byNetwork;
  }

  // ---------------------------------------------------------------- spend controls

  private List<PaymentRequirements> applySpendControls(
      int x402Version,
      List<PaymentRequirements> requirements,
      Map<String, Map<String, SchemeNetworkClient>> byNetwork) {
    SpendControls controls = spendControls;
    if (!controls.enabled()) {
      return requirements;
    }
    Function<PaymentRequirements, DefaultAsset> defaultAsset = r -> {
      SchemeNetworkClient c = Networks.findByNetworkAndScheme(byNetwork, r.scheme(), r.network());
      return c == null ? null : c.findDefaultAsset(r.asset(), r.network());
    };
    List<PaymentRequirements> filtered = controls.allowAnyAsset() ? requirements
        : requirements.stream().filter(r -> defaultAsset.apply(r) != null
            || findEntry(controls, r, defaultAsset.apply(r)) != null).toList();
    if (filtered.isEmpty()) {
      throw new X402ClientException("All payment requirements were rejected by spendControls: "
          + "only default assets or entries in spendControls.allowedAssets are allowed. Add an "
          + "allowedAssets entry for non-default tokens, set allowedAssets: true, or set "
          + "spendControls: false.");
    }
    String usdLimit = controls.maxAmountPerPayment();
    List<PaymentRequirements> beforeCaps = filtered;
    boolean rejectedByAssetCap = false;
    String rejectedUsdSymbol = null;
    List<PaymentRequirements> kept = new ArrayList<>();
    for (PaymentRequirements r : filtered) {
      DefaultAsset asset = defaultAsset.apply(r);
      SpendControls.AllowedAsset entry = findEntry(controls, r, asset);
      String cap = resolveAtomicCap(controls, r, asset);
      if (cap == null) {
        kept.add(r);
        continue;
      }
      boolean entryCap = entry != null && entry.maxAmountPerPayment() != null;
      if (!isAtomic(r.amount())) {
        if (entryCap) {
          rejectedByAssetCap = true;
          continue;
        }
        if (usdLimit == null) {
          kept.add(r);
          continue;
        }
        BigInteger value = new BigInteger(Amounts.convertToTokenAmount(r.amount(), 18));
        BigInteger limit = new BigInteger(
            Amounts.convertToTokenAmount(Amounts.parseMoney(usdLimit).amount(), 18));
        if (value.compareTo(limit) <= 0) {
          kept.add(r);
        } else {
          rejectedUsdSymbol = asset == null ? null : asset.symbol();
        }
        continue;
      }
      if (new BigInteger(r.amount()).compareTo(new BigInteger(cap)) <= 0) {
        kept.add(r);
      } else if (entryCap) {
        rejectedByAssetCap = true;
      } else {
        rejectedUsdSymbol = asset == null ? null : asset.symbol();
      }
    }
    if (kept.isEmpty()) {
      boolean allEntryCapped = beforeCaps.stream().allMatch(r -> {
        SpendControls.AllowedAsset e = findEntry(controls, r, defaultAsset.apply(r));
        return e != null && e.maxAmountPerPayment() != null;
      });
      if (rejectedByAssetCap && allEntryCapped) {
        throw new X402ClientException("All payment requirements were rejected by "
            + "spendControls.allowedAssets maxAmountPerPayment. Raise the per-asset cap, or omit "
            + "maxAmountPerPayment to allow uncapped (default assets then fall back to the "
            + "top-level USD cap).");
      }
      throw new X402ClientException("All payment requirements were rejected by "
          + "spendControls.maxAmountPerPayment (" + (usdLimit == null ? "false" : usdLimit)
          + (rejectedUsdSymbol != null ? ", including " + rejectedUsdSymbol : "") + "). Raise "
          + "maxAmountPerPayment, set it to false to disable, set "
          + "allowedAssets[].maxAmountPerPayment for a per-asset atomic cap, or set "
          + "spendControls: false to disable all spend controls.");
    }
    return kept;
  }

  private static SpendControls.AllowedAsset findEntry(
      SpendControls controls, PaymentRequirements r, DefaultAsset defaultAsset) {
    // Searched under allowAnyAsset too: it widens which assets are allowed, never drops a cap.
    for (SpendControls.AllowedAsset entry : controls.allowedAssets()) {
      if (!Networks.matchesPattern(entry.network(), r.network())) {
        continue;
      }
      if (r.asset() != null && entry.asset().equalsIgnoreCase(r.asset())) {
        return entry;
      }
      if (defaultAsset != null && defaultAsset.symbol().equalsIgnoreCase(entry.asset())) {
        return entry;
      }
    }
    return null;
  }

  private static String resolveAtomicCap(
      SpendControls controls, PaymentRequirements r, DefaultAsset defaultAsset) {
    if (!controls.enabled()) {
      return null;
    }
    SpendControls.AllowedAsset entry = findEntry(controls, r, defaultAsset);
    if (entry != null && entry.maxAmountPerPayment() != null) {
      if (!isAtomic(entry.maxAmountPerPayment())) {
        throw new X402ClientException("spendControls.allowedAssets[].maxAmountPerPayment must be "
            + "an integer atomic amount, not a dollar value; got "
            + X402Json.write(entry.maxAmountPerPayment()));
      }
      return entry.maxAmountPerPayment();
    }
    if (defaultAsset == null || controls.maxAmountPerPayment() == null) {
      return null;
    }
    return Amounts.convertToTokenAmount(
        Amounts.parseMoney(controls.maxAmountPerPayment()).amount(), defaultAsset.decimals());
  }

  private static boolean isAtomic(String amount) {
    return amount != null && amount.matches("\\d+");
  }

  // ---------------------------------------------------------------- hooks & extensions

  private <H> List<H> hooks(
      List<H> manual, Function<SchemeClientHooks, H> pick, int version, PaymentRequirements r) {
    List<H> out = new ArrayList<>(manual);
    if (version == X402_VERSION) {
      SchemeNetworkClient scheme = Networks.findByNetworkAndScheme(registered, r.scheme(),
          r.network());
      SchemeClientHooks hooks = scheme == null ? null : scheme.schemeHooks();
      H hook = hooks == null ? null : pick.apply(hooks);
      if (hook != null) {
        out.add(hook);
      }
    }
    return out;
  }

  /**
   * Server declarations overlaid by scheme-provided extension data.
   * Objects merge recursively, the server value wins on conflicting leaves, and additive array
   * fields (builder-code {@code s}) are concatenated without duplicates, client first.
   *
   * @param server the 402's extensions, may be {@code null}
   * @param client the scheme's extensions, may be {@code null}
   * @return the merged extensions
   */
  @SuppressWarnings("unchecked")
  static Map<String, Object> mergeExtensions(Map<String, Object> server,
      Map<String, Object> client) {
    if (client == null) {
      return server;
    }
    if (server == null) {
      return client;
    }
    Map<String, Object> merged = new LinkedHashMap<>(server);
    for (Map.Entry<String, Object> entry : client.entrySet()) {
      Object serverValue = merged.get(entry.getKey());
      if (!(serverValue instanceof Map) || !(entry.getValue() instanceof Map)) {
        merged.put(entry.getKey(), entry.getValue());
        continue;
      }
      Set<String> additive =
          JsonValues.ADDITIVE_ARRAY_INFO_FIELDS.getOrDefault(entry.getKey(), Set.of());
      Map<String, Object> value = new LinkedHashMap<>((Map<String, Object>) serverValue);
      Deque<MergeStep> pending = new ArrayDeque<>();
      pending.add(new MergeStep(value, (Map<String, Object>) entry.getValue()));
      while (!pending.isEmpty()) {
        MergeStep step = pending.poll();
        Map<String, Object> target = step.target();
        for (Map.Entry<String, Object> field : step.source().entrySet()) {
          Object serverField = target.get(field.getKey());
          Object clientField = field.getValue();
          if (serverField instanceof Map && clientField instanceof Map) {
            Map<String, Object> nested =
                new LinkedHashMap<>((Map<String, Object>) serverField);
            target.put(field.getKey(), nested);
            pending.add(new MergeStep(nested, (Map<String, Object>) clientField));
            continue;
          }
          if (additive.contains(field.getKey())
              && (serverField instanceof List || clientField instanceof List)) {
            List<Object> serverArray = comparable(serverField);
            List<Object> clientArray = comparable(clientField);
            if (serverArray != null && clientArray != null) {
              target.put(field.getKey(), mergeUnique(clientArray, serverArray));
              continue;
            }
          }
          if (!target.containsKey(field.getKey())) {
            target.put(field.getKey(), clientField);
          }
        }
      }
      merged.put(entry.getKey(), value);
    }
    return merged;
  }

  private record MergeStep(Map<String, Object> target, Map<String, Object> source) {}

  @SuppressWarnings("unchecked")
  private static List<Object> comparable(Object value) {
    if (value instanceof List) {
      return (List<Object>) value;
    }
    return value == null || value instanceof Map ? null : List.of(value);
  }

  private static List<Object> mergeUnique(List<Object> first, List<Object> second) {
    List<Object> out = new ArrayList<>();
    for (List<Object> list : List.of(first, second)) {
      for (Object item : list) {
        if (out.stream().noneMatch(existing -> JsonValues.deepEqual(existing, item))) {
          out.add(item);
        }
      }
    }
    return out;
  }
}
