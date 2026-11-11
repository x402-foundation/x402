package org.x402.core.facilitator;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import org.x402.core.FacilitatorContext;
import org.x402.core.FacilitatorExtension;
import org.x402.core.SchemeNetworkFacilitator;
import org.x402.core.SettleAbortedException;
import org.x402.core.facilitator.FacilitatorHooks.AfterSettleHook;
import org.x402.core.facilitator.FacilitatorHooks.AfterVerifyHook;
import org.x402.core.facilitator.FacilitatorHooks.BeforeSettleHook;
import org.x402.core.facilitator.FacilitatorHooks.BeforeVerifyHook;
import org.x402.core.facilitator.FacilitatorHooks.OnSettleFailureHook;
import org.x402.core.facilitator.FacilitatorHooks.OnVerifyFailureHook;
import org.x402.core.facilitator.FacilitatorHooks.SettleContext;
import org.x402.core.facilitator.FacilitatorHooks.SettleFailureContext;
import org.x402.core.facilitator.FacilitatorHooks.SettleResultContext;
import org.x402.core.facilitator.FacilitatorHooks.VerifyContext;
import org.x402.core.facilitator.FacilitatorHooks.VerifyFailureContext;
import org.x402.core.facilitator.FacilitatorHooks.VerifyResultContext;
import org.x402.core.hooks.HookResults.Abort;
import org.x402.core.hooks.HookResults.Decision;
import org.x402.core.hooks.HookResults.Recovered;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.core.utils.Networks;

/**
 * The facilitator role: routes verify and settle to
 * the first registered scheme matching scheme and network, runs hooks, and answers {@code
 * /supported}.
 *
 * <ul>
 *   <li>A before-verify abort answers {@code isValid:false} with the reason.
 *   <li>An {@code isValid:false} verdict goes through the verify-failure hooks; a recovery then
 *       runs the after-verify hooks with the recovered result. A thrown error may be
 *       recovered too; after-verify hooks then do not run.
 *   <li>A before-settle abort throws {@link SettleAbortedException} (message {@code Settlement
 *       aborted: …}); mapping it to a wire body is the HTTP handler's job.
 *   <li>Hook exceptions propagate to the caller.
 * </ul>
 *
 * <p>Thread-safe; registration may happen at any time.
 */
public final class X402Facilitator {

  private static final int X402_VERSION = 2;

  private final List<Registration> registrations = new CopyOnWriteArrayList<>();
  private final Map<String, FacilitatorExtension> extensions = new LinkedHashMap<>();
  private final List<BeforeVerifyHook> beforeVerifyHooks = new CopyOnWriteArrayList<>();
  private final List<AfterVerifyHook> afterVerifyHooks = new CopyOnWriteArrayList<>();
  private final List<OnVerifyFailureHook> onVerifyFailureHooks = new CopyOnWriteArrayList<>();
  private final List<BeforeSettleHook> beforeSettleHooks = new CopyOnWriteArrayList<>();
  private final List<AfterSettleHook> afterSettleHooks = new CopyOnWriteArrayList<>();
  private final List<OnSettleFailureHook> onSettleFailureHooks = new CopyOnWriteArrayList<>();
  private final FacilitatorContext context = this::getExtension;

  private record Registration(
      int version, SchemeNetworkFacilitator scheme, Set<String> networks, String pattern) {}

  /**
   * Registers a scheme for one network.
   *
   * @param network the network
   * @param scheme the scheme
   * @return this facilitator
   */
  public X402Facilitator register(String network, SchemeNetworkFacilitator scheme) {
    return register(List.of(network), scheme);
  }

  /**
   * Registers a scheme for several networks. Networks of one namespace also match the wildcard
   * {@code <namespace>:*}; mixed namespaces match only their listed networks.
   *
   * @param networks the networks
   * @param scheme the scheme
   * @return this facilitator
   */
  public X402Facilitator register(List<String> networks, SchemeNetworkFacilitator scheme) {
    Objects.requireNonNull(scheme, "scheme");
    registrations.add(new Registration(X402_VERSION, scheme,
        Collections.unmodifiableSet(new LinkedHashSet<>(networks)),
        derivePattern(networks)));
    return this;
  }

  private static String derivePattern(List<String> networks) {
    if (networks.isEmpty()) {
      return "";
    }
    if (networks.size() == 1) {
      return networks.get(0);
    }
    Set<String> namespaces = new LinkedHashSet<>();
    networks.forEach(n -> namespaces.add(n.split(":", -1)[0]));
    return namespaces.size() == 1 ? namespaces.iterator().next() + ":*" : networks.get(0);
  }

  /**
   * Registers an extension; its key is advertised in {@code /supported}, and schemes can look it
   * up through {@link FacilitatorContext}.
   *
   * @param extension the extension
   * @return this facilitator
   */
  public X402Facilitator registerExtension(FacilitatorExtension extension) {
    synchronized (extensions) {
      extensions.put(extension.key(), extension);
    }
    return this;
  }

  /**
   * Registered extension keys in registration order.
   *
   * @return the keys
   */
  public List<String> getExtensions() {
    synchronized (extensions) {
      return List.copyOf(extensions.keySet());
    }
  }

  /**
   * A registered extension.
   *
   * @param key the key
   * @return the extension, or {@code null}
   */
  public FacilitatorExtension getExtension(String key) {
    synchronized (extensions) {
      return extensions.get(key);
    }
  }

  /**
   * Adds a before-verify hook.
   *
   * @param hook the hook
   * @return this facilitator
   */
  public X402Facilitator onBeforeVerify(BeforeVerifyHook hook) {
    beforeVerifyHooks.add(hook);
    return this;
  }

  /**
   * Adds an after-verify hook.
   *
   * @param hook the hook
   * @return this facilitator
   */
  public X402Facilitator onAfterVerify(AfterVerifyHook hook) {
    afterVerifyHooks.add(hook);
    return this;
  }

  /**
   * Adds a verify-failure hook.
   *
   * @param hook the hook
   * @return this facilitator
   */
  public X402Facilitator onVerifyFailure(OnVerifyFailureHook hook) {
    onVerifyFailureHooks.add(hook);
    return this;
  }

  /**
   * Adds a before-settle hook.
   *
   * @param hook the hook
   * @return this facilitator
   */
  public X402Facilitator onBeforeSettle(BeforeSettleHook hook) {
    beforeSettleHooks.add(hook);
    return this;
  }

  /**
   * Adds an after-settle hook.
   *
   * @param hook the hook
   * @return this facilitator
   */
  public X402Facilitator onAfterSettle(AfterSettleHook hook) {
    afterSettleHooks.add(hook);
    return this;
  }

  /**
   * Adds a settle-failure hook.
   *
   * @param hook the hook
   * @return this facilitator
   */
  public X402Facilitator onSettleFailure(OnSettleFailureHook hook) {
    onSettleFailureHooks.add(hook);
    return this;
  }

  /**
   * The {@code /supported} answer: one kind per registered network, the extension keys, and
   * signer addresses grouped by CAIP family.
   *
   * @return the supported response
   */
  public SupportedResponse getSupported() {
    List<SupportedKind> kinds = new ArrayList<>();
    Map<String, Set<String>> signers = new LinkedHashMap<>();
    for (Registration r : registrations) {
      for (String network : r.networks()) {
        kinds.add(new SupportedKind(r.version(), r.scheme().scheme(), network,
            r.scheme().getExtra(network)));
        signers.computeIfAbsent(r.scheme().caipFamily(), f -> new LinkedHashSet<>())
            .addAll(r.scheme().getSigners(network));
      }
    }
    Map<String, List<String>> grouped = new LinkedHashMap<>();
    signers.forEach((family, set) -> grouped.put(family, List.copyOf(set)));
    return new SupportedResponse(kinds, getExtensions(), grouped);
  }

  /**
   * Verifies a payment.
   *
   * @param payload the payment
   * @param requirements the requirements
   * @return the verdict
   */
  public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) {
    VerifyContext ctx = new VerifyContext(payload, requirements);
    for (BeforeVerifyHook hook : beforeVerifyHooks) {
      Decision decision = hook.apply(ctx);
      if (decision instanceof Abort a) {
        return VerifyResponse.invalid(a.reason(), a.message());
      }
    }
    try {
      VerifyResponse result = find(payload, requirements).verify(payload, requirements, context);
      if (!result.isValid()) {
        String reason = result.invalidReason() == null || result.invalidReason().isEmpty()
            ? "Verification failed" : result.invalidReason();
        String detail = result.invalidMessage();
        VerifyFailureContext failure = new VerifyFailureContext(payload, requirements,
            new IllegalStateException(detail == null || detail.isEmpty() ? reason
                : reason + ": " + detail));
        for (OnVerifyFailureHook hook : onVerifyFailureHooks) {
          Recovery<VerifyResponse> recovery = hook.apply(failure);
          if (recovery instanceof Recovered<VerifyResponse> r) {
            runAfterVerify(new VerifyResultContext(payload, requirements, r.value()));
            return r.value();
          }
        }
        return result;
      }
      runAfterVerify(new VerifyResultContext(payload, requirements, result));
      return result;
    } catch (RuntimeException error) {
      VerifyFailureContext failure = new VerifyFailureContext(payload, requirements, error);
      for (OnVerifyFailureHook hook : onVerifyFailureHooks) {
        if (hook.apply(failure) instanceof Recovered<VerifyResponse> r) {
          return r.value();
        }
      }
      throw error;
    }
  }

  private void runAfterVerify(VerifyResultContext ctx) {
    for (AfterVerifyHook hook : afterVerifyHooks) {
      hook.apply(ctx);
    }
  }

  /**
   * Settles a payment.
   *
   * @param payload the payment
   * @param requirements the requirements
   * @return the result
   * @throws SettleAbortedException when a before-settle hook aborts
   */
  public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) {
    SettleContext ctx = new SettleContext(payload, requirements);
    for (BeforeSettleHook hook : beforeSettleHooks) {
      if (hook.apply(ctx) instanceof Abort a) {
        throw new SettleAbortedException(a.reason());
      }
    }
    try {
      SettleResponse result = find(payload, requirements).settle(payload, requirements, context);
      SettleResultContext done = new SettleResultContext(payload, requirements, result);
      for (AfterSettleHook hook : afterSettleHooks) {
        hook.apply(done);
      }
      return result;
    } catch (RuntimeException error) {
      SettleFailureContext failure = new SettleFailureContext(payload, requirements, error);
      for (OnSettleFailureHook hook : onSettleFailureHooks) {
        if (hook.apply(failure) instanceof Recovered<SettleResponse> r) {
          return r.value();
        }
      }
      throw error;
    }
  }

  private SchemeNetworkFacilitator find(PaymentPayload payload, PaymentRequirements req) {
    List<Registration> forVersion = registrations.stream()
        .filter(r -> r.version() == payload.x402Version()).toList();
    if (forVersion.isEmpty()) {
      throw new IllegalArgumentException(
          "No facilitator registered for x402 version: " + payload.x402Version());
    }
    for (Registration r : forVersion) {
      if (r.scheme().scheme().equals(req.scheme())
          && (r.networks().contains(req.network())
              || Networks.matchesPattern(r.pattern(), req.network()))) {
        return r.scheme();
      }
    }
    throw new IllegalArgumentException("No facilitator registered for scheme: " + req.scheme()
        + " and network: " + req.network());
  }
}
