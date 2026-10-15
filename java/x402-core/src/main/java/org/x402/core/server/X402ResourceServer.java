package org.x402.core.server;

import java.lang.System.Logger.Level;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;
import java.util.function.Function;
import org.x402.core.FacilitatorClient;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FacilitatorStatusException;
import org.x402.core.InProcessFacilitatorClient;
import org.x402.core.PaymentFlow;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.SchemeNetworkServer.PaymentRequiredContext;
import org.x402.core.SettleException;
import org.x402.core.hooks.HookResults.Abort;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.hooks.HookResults.Recovered;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.hooks.HookResults.Skip;
import org.x402.core.hooks.HookResults.SkipHandler;
import org.x402.core.hooks.HookResults.SkipHandlerDirective;
import org.x402.core.server.FacilitatorRoute.AutoWithVerifyFailover;
import org.x402.core.server.FacilitatorRoute.Pinned;
import org.x402.core.server.ServerHooks.AfterSettleHook;
import org.x402.core.server.ServerHooks.AfterVerifyHook;
import org.x402.core.server.ServerHooks.BeforeSettleHook;
import org.x402.core.server.ServerHooks.BeforeVerifyHook;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.core.server.ServerHooks.OnSettleFailureHook;
import org.x402.core.server.ServerHooks.OnVerifiedPaymentCanceledHook;
import org.x402.core.server.ServerHooks.OnVerifyFailureHook;
import org.x402.core.server.ServerHooks.SchemeServerHooks;
import org.x402.core.server.ServerHooks.SettleContext;
import org.x402.core.server.ServerHooks.SettleFailureContext;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerHooks.SettleResultContext;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.core.server.ServerHooks.VerifyContext;
import org.x402.core.server.ServerHooks.VerifyFailureContext;
import org.x402.core.server.ServerHooks.VerifyResultContext;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.core.utils.JsonValues;
import org.x402.core.utils.Networks;

/**
 * The transport-agnostic x402 resource server: builds payment requirements, verifies and settles
 * payments through facilitators, and runs server-wide, scheme and extension hooks.
 *
 * <p><b>Lifecycle.</b> Register schemes, extensions and hooks, then call {@link #initialize()}.
 * Registration after the first {@code initialize()} (or {@link #sync()}) throws {@link
 * IllegalStateException}. {@code initialize()} may be called again to re-sync: each call builds a
 * new immutable {@link RoutingSnapshot} and publishes it with one atomic swap. Overlapping {@code
 * initialize()} calls are allowed: snapshots are numbered when their sync starts, and a published
 * snapshot is never replaced by one from an earlier sync.
 *
 * <p><b>Facilitators.</b> Facilitators are a list in declaration order. The first
 * one listing an exact (version, network, scheme) kind owns it. Options may be pinned to one
 * facilitator by identifier ({@link FacilitatorRoute#pinned}); unpinned options may opt into a
 * one-hop verify failover ({@link FacilitatorRoute#autoWithVerifyFailover}). Settle goes to {@code
 * verifiedBy}, else the pin, else the build facilitator, and never to any other facilitator: trying
 * further facilitators for an unmapped kind could broadcast twice after a timeout.
 *
 * <p>All calls are synchronous and thread-safe once registration is done.
 */
public final class X402ResourceServer {

  /** The protocol version this server builds requirements for. */
  public static final int X402_VERSION = 2;

  private static final System.Logger LOG = System.getLogger(X402ResourceServer.class.getName());
  private static final String NO_KINDS =
      "Failed to initialize: no supported payment kinds loaded from any facilitator.";

  private final Map<String, FacilitatorClient> facilitators;
  private final Object registrationLock = new Object();
  private volatile Map<String, Map<String, SchemeNetworkServer>> schemes = Map.of();
  private volatile Map<String, Map<String, SchemeServerHooks>> schemeHooks = Map.of();
  private volatile Map<String, ResourceServerExtension> extensions = Map.of();
  private final List<BeforeVerifyHook> beforeVerifyHooks = new CopyOnWriteArrayList<>();
  private final List<AfterVerifyHook> afterVerifyHooks = new CopyOnWriteArrayList<>();
  private final List<OnVerifyFailureHook> onVerifyFailureHooks = new CopyOnWriteArrayList<>();
  private final List<BeforeSettleHook> beforeSettleHooks = new CopyOnWriteArrayList<>();
  private final List<AfterSettleHook> afterSettleHooks = new CopyOnWriteArrayList<>();
  private final List<OnSettleFailureHook> onSettleFailureHooks = new CopyOnWriteArrayList<>();
  private final List<OnVerifiedPaymentCanceledHook> onCanceledHooks = new CopyOnWriteArrayList<>();
  private final AtomicReference<RoutingSnapshot> snapshot = new AtomicReference<>();
  private final AtomicLong generations = new AtomicLong();
  private volatile boolean frozen;

  private X402ResourceServer(Map<String, FacilitatorClient> facilitators) {
    this.facilitators = facilitators;
  }

  /**
   * Starts a builder.
   *
   * @return the builder
   */
  public static Builder builder() {
    return new Builder();
  }

  /** Builds an {@link X402ResourceServer}. */
  public static final class Builder {
    private final List<FacilitatorClient> clients = new ArrayList<>();
    private FacilitatorClient local;

    private Builder() {}

    /**
     * Adds facilitators in declaration order (precedence order for unpinned options).
     *
     * @param list the facilitators
     * @return this builder
     */
    public Builder facilitators(List<? extends FacilitatorClient> list) {
      list.forEach(this::facilitator);
      return this;
    }

    /**
     * Adds one facilitator after the ones already added.
     *
     * @param client the facilitator
     * @return this builder
     */
    public Builder facilitator(FacilitatorClient client) {
      clients.add(Objects.requireNonNull(client, "facilitator"));
      return this;
    }

    /**
     * Sets the in-process facilitator ({@code x402.local-facilitator}). It is prepended to
     * the list under the reserved identifier {@code local} and so takes precedence.
     *
     * @param client the in-process client
     * @return this builder
     * @throws IllegalStateException when one is already set
     */
    public Builder localFacilitator(FacilitatorClient client) {
      if (local != null) {
        throw new IllegalStateException("the local facilitator is already set");
      }
      local = Objects.requireNonNull(client, "local facilitator");
      return this;
    }

    /**
     * Builds the server.
     *
     * @return the server
     * @throws IllegalArgumentException with no facilitator, duplicate effective identifiers
     *     (trailing slashes are ignored), or a remote client named {@code local}
     */
    public X402ResourceServer build() {
      if (clients.isEmpty() && local == null) {
        throw new IllegalArgumentException("x402 resource server needs at least one facilitator, "
            + "e.g. an HttpFacilitatorClient for https://x402.org/facilitator");
      }
      Map<String, FacilitatorClient> byId = new LinkedHashMap<>();
      if (local != null) {
        byId.put(Identifiers.LOCAL, local);
      }
      for (FacilitatorClient client : clients) {
        String id = Identifiers.normalize(Objects.requireNonNull(client.identifier(),
            "facilitator identifier"));
        if (Identifiers.LOCAL.equals(id) && !(client instanceof InProcessFacilitatorClient)) {
          throw new IllegalArgumentException("Facilitator identifier \"local\" is reserved for "
              + "the in-process facilitator; register it with localFacilitator(...)");
        }
        if (byId.putIfAbsent(id, client) != null) {
          throw new IllegalArgumentException("Duplicate facilitator identifier \"" + id
              + "\" (identifiers are compared without trailing slashes)");
        }
      }
      return new X402ResourceServer(Collections.unmodifiableMap(byId));
    }
  }

  // ---------------------------------------------------------------- registration

  /**
   * Registers a scheme for a network or network pattern. A later
   * registration for the same network and scheme replaces the earlier one.
   *
   * @param network the network, or a pattern such as {@code cardano:*}
   * @param server the scheme
   * @return this server
   * @throws IllegalStateException after the first {@link #initialize()}
   */
  public X402ResourceServer register(String network, SchemeNetworkServer server) {
    Objects.requireNonNull(network, "network");
    Objects.requireNonNull(server, "server");
    synchronized (registrationLock) {
      checkOpen();
      Map<String, Map<String, SchemeNetworkServer>> next = copy(schemes);
      next.computeIfAbsent(network, n -> new LinkedHashMap<>()).put(server.scheme(), server);
      schemes = freezeNested(next);
      Map<String, Map<String, SchemeServerHooks>> hooks = copy(schemeHooks);
      Map<String, SchemeServerHooks> byScheme =
          hooks.computeIfAbsent(network, n -> new LinkedHashMap<>());
      SchemeServerHooks h = server.schemeHooks();
      if (h == null) {
        byScheme.remove(server.scheme());
      } else {
        byScheme.put(server.scheme(), h);
      }
      schemeHooks = freezeNested(hooks);
    }
    return this;
  }

  /**
   * Whether a scheme is registered for a network (with pattern matching).
   *
   * @param network the network
   * @param scheme the scheme
   * @return {@code true} when registered
   */
  public boolean hasRegisteredScheme(String network, String scheme) {
    return getRegisteredScheme(network, scheme) != null;
  }

  /**
   * The registered scheme for a network (with pattern matching).
   *
   * @param network the network
   * @param scheme the scheme
   * @return the scheme, or {@code null}
   */
  public SchemeNetworkServer getRegisteredScheme(String network, String scheme) {
    return Networks.findByNetworkAndScheme(schemes, scheme, network);
  }

  /**
   * Registers an extension; the same key replaces an earlier registration.
   *
   * @param extension the extension
   * @return this server
   * @throws IllegalStateException after the first {@link #initialize()}
   */
  public X402ResourceServer registerExtension(ResourceServerExtension extension) {
    Objects.requireNonNull(extension, "extension");
    synchronized (registrationLock) {
      checkOpen();
      Map<String, ResourceServerExtension> next = new LinkedHashMap<>(extensions);
      next.put(extension.key(), extension);
      extensions = Collections.unmodifiableMap(next);
    }
    return this;
  }

  /**
   * Whether an extension is registered.
   *
   * @param key the key
   * @return {@code true} when registered
   */
  public boolean hasExtension(String key) {
    return extensions.containsKey(key);
  }

  /**
   * A registered extension.
   *
   * @param key the key
   * @return the extension, or {@code null}
   */
  public ResourceServerExtension getExtension(String key) {
    return extensions.get(key);
  }

  /**
   * All registered extensions in registration order.
   *
   * @return the extensions
   */
  public List<ResourceServerExtension> getExtensions() {
    return List.copyOf(extensions.values());
  }

  /**
   * Adds a before-verify hook; it may abort (→ invalid) or skip the facilitator.
   *
   * @param hook the hook
   * @return this server
   */
  public X402ResourceServer onBeforeVerify(BeforeVerifyHook hook) {
    return addHook(beforeVerifyHooks, hook);
  }

  /**
   * Adds an after-verify hook; it may abort (→ invalid + cancel) or skip the handler.
   *
   * @param hook the hook
   * @return this server
   */
  public X402ResourceServer onAfterVerify(AfterVerifyHook hook) {
    return addHook(afterVerifyHooks, hook);
  }

  /**
   * Adds a verify-failure hook; it may recover with a result.
   *
   * @param hook the hook
   * @return this server
   */
  public X402ResourceServer onVerifyFailure(OnVerifyFailureHook hook) {
    return addHook(onVerifyFailureHooks, hook);
  }

  /**
   * Adds a before-settle hook; an abort throws a 400 {@link SettleException}.
   *
   * @param hook the hook
   * @return this server
   */
  public X402ResourceServer onBeforeSettle(BeforeSettleHook hook) {
    return addHook(beforeSettleHooks, hook);
  }

  /**
   * Adds an after-settle hook.
   *
   * @param hook the hook
   * @return this server
   */
  public X402ResourceServer onAfterSettle(AfterSettleHook hook) {
    return addHook(afterSettleHooks, hook);
  }

  /**
   * Adds a settle-failure hook; it may recover with a result.
   *
   * @param hook the hook
   * @return this server
   */
  public X402ResourceServer onSettleFailure(OnSettleFailureHook hook) {
    return addHook(onSettleFailureHooks, hook);
  }

  /**
   * Adds a hook fired when a verified payment is cancelled before settlement.
   *
   * @param hook the hook
   * @return this server
   */
  public X402ResourceServer onVerifiedPaymentCanceled(OnVerifiedPaymentCanceledHook hook) {
    return addHook(onCanceledHooks, hook);
  }

  private <H> X402ResourceServer addHook(List<H> list, H hook) {
    Objects.requireNonNull(hook, "hook");
    synchronized (registrationLock) {
      checkOpen();
      list.add(hook);
    }
    return this;
  }

  private void checkOpen() {
    if (frozen) {
      throw new IllegalStateException(
          "x402 resource server: register schemes, extensions and hooks before initialize()");
    }
  }

  // ---------------------------------------------------------------- facilitators & sync

  /**
   * Facilitator identifiers in declaration order (normalized).
   *
   * @return the identifiers
   */
  public List<String> facilitatorIdentifiers() {
    return List.copyOf(facilitators.keySet());
  }

  /**
   * A facilitator by identifier; trailing slashes are ignored.
   *
   * @param identifier the identifier
   * @return the client, or {@code null}
   */
  public FacilitatorClient facilitator(String identifier) {
    return identifier == null ? null : facilitators.get(Identifiers.normalize(identifier));
  }

  /**
   * An identifier as this server stores it (trailing slashes removed), e.g. to compare a pin.
   *
   * @param identifier the identifier
   * @return the normalized identifier
   */
  public static String normalizeIdentifier(String identifier) {
    return Identifiers.normalize(identifier);
  }

  /**
   * The facilitators that may take over a verify from {@code owner} when it is unavailable: every
   * other facilitator listing the same kind with the same {@code extra}, in declaration order.
   *
   * @param snap the routing snapshot
   * @param owner the facilitator that owns the kind
   * @param version the x402 version
   * @param network the network
   * @param scheme the scheme
   * @return the candidates, possibly empty
   */
  public List<String> failoverCandidates(RoutingSnapshot snap, String owner, int version,
      String network, String scheme) {
    List<String> out = new ArrayList<>();
    SupportedKind built = snap.kindOf(owner, version, network, scheme);
    if (built == null) {
      return out;
    }
    for (String id : snap.facilitatorIdentifiers()) {
      SupportedKind kind = snap.kindOf(id, version, network, scheme);
      if (!id.equals(owner) && kind != null
          && JsonValues.deepEqual(extraOf(kind), extraOf(built))) {
        out.add(id);
      }
    }
    return out;
  }

  /**
   * Fetches {@code /supported} from every facilitator in declaration order and builds a new
   * snapshot without publishing it. A failing facilitator is logged and recorded in {@link
   * RoutingSnapshot#failures()}; the others still count. Ends registration.
   *
   * @return the new snapshot
   */
  public RoutingSnapshot sync() {
    freeze();
    // Numbered when it starts: a sync that began earlier stays older, whenever it finishes.
    long generation = generations.incrementAndGet();
    Map<String, SupportedResponse> answers = new LinkedHashMap<>();
    Map<String, Throwable> failures = new LinkedHashMap<>();
    facilitators.forEach((id, client) -> {
      try {
        answers.put(id, Objects.requireNonNull(client.getSupported(), "supported response"));
      } catch (RuntimeException e) {
        recordSyncFailure(failures, id, e);
      }
    });
    return RoutingSnapshot.build(generation, facilitators, answers, failures);
  }

  /**
   * Like {@link #sync()}, but queries all facilitators in parallel on {@code executor} within a
   * total {@code budget}. Results are still applied in declaration order, so precedence is
   * unchanged; a facilitator that has not answered when the budget is spent counts as failed
   * with a {@link FacilitatorResponseException.Timeout}.
   *
   * @param budget the total time allowed
   * @param executor runs the {@code /supported} calls
   * @return the new snapshot
   */
  public RoutingSnapshot sync(Duration budget, Executor executor) {
    long generation = generations.incrementAndGet();
    freeze();
    long deadline = System.nanoTime() + budget.toNanos();
    Map<String, CompletableFuture<SupportedResponse>> calls = new LinkedHashMap<>();
    facilitators.forEach((id, client) ->
        calls.put(id, CompletableFuture.supplyAsync(client::getSupported, executor)));
    Map<String, SupportedResponse> answers = new LinkedHashMap<>();
    Map<String, Throwable> failures = new LinkedHashMap<>();
    calls.forEach((id, call) -> {
      try {
        long remaining = Math.max(0, deadline - System.nanoTime());
        answers.put(id, Objects.requireNonNull(call.get(remaining, TimeUnit.NANOSECONDS),
            "supported response"));
      } catch (TimeoutException | CancellationException e) {
        call.cancel(true);
        recordSyncFailure(failures, id,
            new FacilitatorResponseException.Timeout("supported", budget.toMillis()));
      } catch (ExecutionException e) {
        recordSyncFailure(failures, id, e.getCause());
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        call.cancel(true);
        recordSyncFailure(failures, id, e);
      } catch (RuntimeException e) {
        recordSyncFailure(failures, id, e);
      }
    });
    return RoutingSnapshot.build(generation, facilitators, answers, failures);
  }

  private static void recordSyncFailure(Map<String, Throwable> failures, String id, Throwable e) {
    failures.put(id, e);
    LOG.log(Level.WARNING, "[x402] Failed to fetch supported kinds from facilitator \"" + id
        + "\": " + e);
  }

  /**
   * Publishes a snapshot built by {@link #sync()} with one atomic swap, unless a newer one (a
   * later sync) is already published: overlapping syncs never move routing backwards.
   *
   * @param next the snapshot
   * @throws IllegalArgumentException when it was built for other facilitators
   */
  public void publish(RoutingSnapshot next) {
    if (!next.facilitatorIdentifiers().equals(facilitatorIdentifiers())) {
      throw new IllegalArgumentException("snapshot belongs to another facilitator list");
    }
    freeze();
    snapshot.accumulateAndGet(next,
        (current, candidate) -> current == null || current.generation() < candidate.generation()
            ? candidate : current);
  }

  /**
   * Syncs, publishes the new snapshot, then validates facilitator capabilities.
   *
   * @return the published snapshot
   * @throws IllegalStateException when no facilitator listed any kind (retryable; the cause is
   *     the last facilitator error)
   * @throws FacilitatorCapabilityError when a facilitator cannot serve a registered scheme (fatal)
   */
  public RoutingSnapshot initialize() {
    RoutingSnapshot next = sync();
    publish(next);
    if (!next.hasKinds()) {
      Throwable last = next.failures().values().stream().reduce((a, b) -> b).orElse(null);
      throw new IllegalStateException(NO_KINDS, last);
    }
    List<String> problems = validateFacilitatorCapabilities(next);
    if (!problems.isEmpty()) {
      throw new FacilitatorCapabilityError(problems);
    }
    return next;
  }

  /**
   * The currently published snapshot.
   *
   * @return the snapshot, or {@code null} before the first publish
   */
  public RoutingSnapshot snapshot() {
    return snapshot.get();
  }

  /**
   * Asks every registered scheme whether the
   * owner's kind can serve it.
   *
   * @param snap the snapshot to check
   * @return one line per problem, {@code "<scheme> on <network>: <problem>"}
   */
  public List<String> validateFacilitatorCapabilities(RoutingSnapshot snap) {
    return facilitatorCapabilityProblems(snap).stream().map(CapabilityProblem::line).toList();
  }

  /**
   * {@link #validateFacilitatorCapabilities} with structure, so a transport layer can tell which
   * owner each problem belongs to.
   *
   * @param snap the snapshot to check
   * @return the problems
   */
  public List<CapabilityProblem> facilitatorCapabilityProblems(RoutingSnapshot snap) {
    List<CapabilityProblem> problems = new ArrayList<>();
    schemes.forEach((network, byScheme) -> byScheme.forEach((name, server) -> {
      for (int version : snap.versions()) {
        SupportedKind kind = snap.supportedKind(version, network, name);
        if (kind == null) {
          continue;
        }
        String problem = server.validateFacilitatorSupport(network, kind,
            snap.ownerExtensions(version, network, name));
        if (problem != null) {
          problems.add(new CapabilityProblem(name, network, snap.owner(version, network, name),
              problem));
        }
      }
    }));
    return problems;
  }

  /**
   * A registered scheme the owner of its kind cannot serve.
   *
   * @param scheme the scheme
   * @param network the registered network key (may be a pattern)
   * @param facilitator the owner of the kind
   * @param problem the scheme's message
   */
  public record CapabilityProblem(String scheme, String network, String facilitator,
      String problem) {

    /**
     * The line {@code "<scheme> on <network>: <problem>"}.
     *
     * @return the line
     */
    public String line() {
      return scheme + " on " + network + ": " + problem;
    }
  }

  /**
   * The owner's exact kind in the current snapshot.
   *
   * @param x402Version the version
   * @param network the network
   * @param scheme the scheme
   * @return the kind, or {@code null}
   */
  public SupportedKind getSupportedKind(int x402Version, String network, String scheme) {
    RoutingSnapshot snap = snapshot.get();
    return snap == null ? null : snap.supportedKind(x402Version, network, scheme);
  }

  /**
   * Decimals of the asset in requirements, falling back to 6 (display only).
   *
   * @param requirements the requirements
   * @return the decimals
   */
  public int getAssetDecimalsForRequirements(PaymentRequirements requirements) {
    SchemeNetworkServer scheme = getRegisteredScheme(requirements.network(), requirements.scheme());
    Integer decimals = scheme == null ? null : scheme.getAssetDecimals(
        requirements.asset() == null ? "" : requirements.asset(), requirements.network());
    return decimals == null ? 6 : decimals;
  }

  // ---------------------------------------------------------------- building

  /**
   * The facilitator whose kind builds an option's requirements: the pin, else the owner.
   *
   * @param config the option
   * @param snap the snapshot, or {@code null} for the current one
   * @return the identifier, or {@code null} for an unpinned option without owner
   * @throws IllegalArgumentException for an unknown pin
   */
  public String buildFacilitator(ResourceConfig config, RoutingSnapshot snap) {
    if (config.facilitator() != null) {
      return requireKnown(config.facilitator());
    }
    RoutingSnapshot s = resolve(snap);
    return s == null ? null : s.owner(X402_VERSION, config.network(), config.scheme());
  }

  /**
   * Builds requirements with the current snapshot.
   *
   * @param config the option
   * @return a one-element list
   * @see #buildPaymentRequirements(ResourceConfig, RoutingSnapshot)
   */
  public List<PaymentRequirements> buildPaymentRequirements(ResourceConfig config) {
    return buildPaymentRequirements(config, null);
  }

  /**
   * Builds an option's requirements using its build facilitator: its exact
   * kind for {@code enhancePaymentRequirements}, its extensions, and (for a pin) its {@code
   * validateFacilitatorSupport}. Price {@code extra} merges below the option's {@code extra};
   * the payment flow is resolved and applied to the wire {@code extra}.
   *
   * @param config the option
   * @param snap the snapshot to build with, or {@code null} for the current one
   * @return a one-element list
   * @throws IllegalStateException when no scheme is registered or no facilitator lists the kind
   * @throws IllegalArgumentException for an unknown pin
   * @throws FacilitatorCapabilityError when the pinned facilitator lacks the kind or capability
   */
  public List<PaymentRequirements> buildPaymentRequirements(
      ResourceConfig config, RoutingSnapshot snap) {
    SchemeNetworkServer scheme = getRegisteredScheme(config.network(), config.scheme());
    if (scheme == null) {
      throw new IllegalStateException("No server implementation registered for "
          + config.scheme() + " on " + config.network()
          + ". Make sure to call register() with a scheme server for this network.");
    }
    RoutingSnapshot s = resolve(snap);
    SupportedKind kind;
    List<String> facilitatorExtensions;
    if (config.facilitator() != null) {
      String pin = requireKnown(config.facilitator());
      kind = s == null ? null : s.kindOf(pin, X402_VERSION, config.network(), scheme.scheme());
      if (kind == null) {
        throw new FacilitatorCapabilityError(List.of(scheme.scheme() + " on " + config.network()
            + ": pinned facilitator \"" + pin + "\" does not list this kind in /supported"));
      }
      facilitatorExtensions = s.extensions(pin);
      String problem = scheme.validateFacilitatorSupport(config.network(), kind,
          facilitatorExtensions);
      if (problem != null) {
        throw new FacilitatorCapabilityError(List.of(scheme.scheme() + " on " + config.network()
            + ": " + problem + " (pinned facilitator \"" + pin + "\")"));
      }
    } else {
      kind = s == null ? null : s.supportedKind(X402_VERSION, config.network(), scheme.scheme());
      if (kind == null) {
        throw new IllegalStateException("Facilitator does not support " + scheme.scheme()
            + " on " + config.network()
            + ". Make sure to call initialize() to fetch supported kinds from facilitators.");
      }
      facilitatorExtensions = s.ownerExtensions(X402_VERSION, config.network(), scheme.scheme());
    }
    AssetAmount price = scheme.parsePrice(config.price(), config.network());
    Map<String, Object> extra = PaymentFlows.mergeExtra(price.extra(), config.extra());
    PaymentRequirements base = new PaymentRequirements(scheme.scheme(), config.network(),
        price.asset(), price.amount(), config.payTo(), config.effectiveMaxTimeoutSeconds(), extra);
    PaymentRequirements enhanced =
        scheme.enhancePaymentRequirements(base, kind, facilitatorExtensions);
    PaymentFlows.Resolved flow = PaymentFlows.resolve(scheme, enhanced);
    return List.of(enhanced.withExtra(PaymentFlows.applyWireExtra(enhanced.extra(), flow)));
  }

  /**
   * Lets registered extensions rewrite route declarations; a
   * throwing extension keeps the declaration and logs a warning.
   *
   * @param declared the route's declarations
   * @param transportContext transport data
   * @return the enriched declarations, in the same order
   */
  public Map<String, Object> enrichExtensions(Map<String, Object> declared, Object transportContext) {
    Map<String, Object> out = new LinkedHashMap<>();
    declared.forEach((key, declaration) -> {
      ResourceServerExtension ext = extensions.get(key);
      if (ext == null) {
        out.put(key, declaration);
        return;
      }
      try {
        out.put(key, ext.enrichDeclaration(declaration, transportContext));
      } catch (RuntimeException e) {
        warnExtension(key, "enrichDeclaration", e);
        out.put(key, declaration);
      }
    });
    return out;
  }

  /**
   * Builds the 402 body, after scheme enrichment (which
   * may only add {@code extra} keys to its own accepts) and extension enrichment.
   *
   * @param requirements the requirements
   * @param resource the resource
   * @param error the error, may be {@code null}
   * @param declaredExtensions the route's (enriched) extension declarations, may be {@code null}
   * @param transportContext transport data
   * @param paymentPayload the rejected payload, may be {@code null}
   * @return the 402 body
   * @throws IllegalStateException when a scheme breaks the mutation policy
   */
  public PaymentRequired createPaymentRequiredResponse(
      List<PaymentRequirements> requirements,
      ResourceInfo resource,
      String error,
      Map<String, Object> declaredExtensions,
      Object transportContext,
      PaymentPayload paymentPayload) {
    List<PaymentRequirements> working = List.copyOf(requirements);
    List<PaymentRequirements> baseline = working;
    Map<String, Object> responseExtensions =
        declaredExtensions == null || declaredExtensions.isEmpty() ? null
            : new LinkedHashMap<>(declaredExtensions);
    PaymentRequired response =
        new PaymentRequired(X402_VERSION, error, resource, working, responseExtensions);
    for (int i = 0; i < working.size(); i++) {
      PaymentRequirements accept = working.get(i);
      SchemeNetworkServer scheme = getRegisteredScheme(accept.network(), accept.scheme());
      if (scheme == null) {
        continue;
      }
      List<PaymentRequirements> enriched = scheme.enrichPaymentRequiredResponse(
          new PaymentRequiredContext(working, paymentPayload, resource, error, response,
              transportContext));
      if (enriched != null) {
        working = List.copyOf(enriched);
        response = new PaymentRequired(X402_VERSION, error, resource, working, responseExtensions);
      }
      HookPolicy.assertAdditiveExtraAfterSchemeEnrich(baseline, working, accept.scheme(),
          accept.network());
      baseline = working;
    }
    if (declaredExtensions != null) {
      for (Map.Entry<String, Object> e : declaredExtensions.entrySet()) {
        ResourceServerExtension ext = extensions.get(e.getKey());
        if (ext == null) {
          continue;
        }
        try {
          Object data = ext.enrichPaymentRequiredResponse(e.getValue(),
              new PaymentRequiredContext(working, paymentPayload, resource, error, response,
                  transportContext));
          if (data != null) {
            if (responseExtensions == null) {
              responseExtensions = new LinkedHashMap<>();
            }
            responseExtensions.put(e.getKey(), data);
            response = new PaymentRequired(X402_VERSION, error, resource, working,
                responseExtensions);
          }
        } catch (RuntimeException ex) {
          warnExtension(e.getKey(), "enrichPaymentRequiredResponse", ex);
        }
      }
    }
    return response;
  }

  /**
   * Finds the advertised requirements a payment answers: v2 needs equal core fields and the
   * advertised {@code extra} as a subset of the accepted one, minus the scheme's dynamic fields; v1
   * matches scheme and network.
   *
   * @param available the advertised requirements
   * @param payload the payment
   * @return the first match, or {@code null}
   * @throws IllegalArgumentException for an unsupported version
   */
  public PaymentRequirements findMatchingRequirements(
      List<PaymentRequirements> available, PaymentPayload payload) {
    PaymentRequirements accepted = payload.accepted();
    switch (payload.x402Version()) {
      case 2:
        if (accepted == null) {
          return null;
        }
        for (PaymentRequirements required : available) {
          SchemeNetworkServer scheme = getRegisteredScheme(required.network(), required.scheme());
          if (matchesAccepted(required, accepted,
              scheme == null ? List.of() : scheme.dynamicExtraFields())) {
            return required;
          }
        }
        return null;
      case 1:
        if (accepted == null) {
          return null;
        }
        return available.stream()
            .filter(r -> r.scheme().equals(accepted.scheme())
                && r.network().equals(accepted.network()))
            .findFirst().orElse(null);
      default:
        throw new IllegalArgumentException("Unsupported x402 version: " + payload.x402Version());
    }
  }

  private static boolean matchesAccepted(
      PaymentRequirements required, PaymentRequirements accepted, List<String> dynamic) {
    if (!Objects.equals(required.scheme(), accepted.scheme())
        || !Objects.equals(required.network(), accepted.network())
        || !Objects.equals(required.asset(), accepted.asset())
        || !Objects.equals(required.amount(), accepted.amount())
        || !Objects.equals(required.payTo(), accepted.payTo())
        || required.maxTimeoutSeconds() != accepted.maxTimeoutSeconds()) {
      return false;
    }
    return JsonValues.containsSubset(JsonValues.omit(required.extra(), dynamic),
        JsonValues.omit(accepted.extra(), dynamic));
  }

  /**
   * Client extension echoes must preserve the advertised
   * {@code info} (minus dynamic fields) and never invent server-owned fields.
   *
   * @param paymentRequired the 402 the payment answers
   * @param payload the payment
   * @return the validation result
   */
  public ExtensionValidation validateExtensions(
      PaymentRequired paymentRequired, PaymentPayload payload) {
    if (payload.x402Version() != 2) {
      return ExtensionValidation.VALID;
    }
    Map<String, Object> server = paymentRequired.extensions();
    Map<String, Object> client = payload.extensions();
    if (client == null || client.isEmpty()) {
      return ExtensionValidation.VALID;
    }
    for (Map.Entry<String, Object> e : client.entrySet()) {
      String key = e.getKey();
      Object advertised = info(server == null ? null : server.get(key));
      Object echoed = info(e.getValue());
      if (server != null && server.containsKey(key)) {
        ResourceServerExtension ext = extensions.get(key);
        List<String> dynamic = ext == null ? List.of() : ext.dynamicInfoFields();
        if (!JsonValues.containsSubset(omitIfRecord(advertised, dynamic),
            omitIfRecord(echoed, dynamic),
            JsonValues.ADDITIVE_ARRAY_INFO_FIELDS.getOrDefault(key, Set.of()),
            JsonValues.ADDITIVE_ARRAY_MAX_LENGTHS.getOrDefault(key, Map.of()))) {
          return ExtensionValidation.mismatch(key);
        }
      }
      Set<String> owned = JsonValues.SERVER_OWNED_INFO_FIELDS.get(key);
      if (owned != null && !serverOwnedMatch(advertised, echoed, owned)) {
        return ExtensionValidation.mismatch(key);
      }
    }
    return ExtensionValidation.VALID;
  }

  @SuppressWarnings("unchecked")
  private static Object info(Object value) {
    if (value instanceof Map<?, ?> m && m.containsKey("info")) {
      return ((Map<String, Object>) m).get("info");
    }
    return value;
  }

  @SuppressWarnings("unchecked")
  private static Object omitIfRecord(Object value, List<String> fields) {
    return value instanceof Map ? JsonValues.omit((Map<String, Object>) value, fields) : value;
  }

  private static boolean serverOwnedMatch(Object advertised, Object echoed, Set<String> owned) {
    if (!(echoed instanceof Map<?, ?> echoedMap)) {
      return true;
    }
    Map<?, ?> advertisedMap = advertised instanceof Map<?, ?> m ? m : Map.of();
    for (String field : owned) {
      if (!echoedMap.containsKey(field)) {
        continue;
      }
      Object value = echoedMap.get(field);
      if (!advertisedMap.containsKey(field)
          || !JsonValues.deepEqual(advertisedMap.get(field), value)) {
        return false;
      }
    }
    return true;
  }

  /**
   * The payment flow of requirements, from the scheme's table.
   *
   * @param payload the payment (unused; the flow is requirements-driven)
   * @param requirements the requirements
   * @return the flow
   * @throws IllegalStateException when no scheme is registered
   */
  public PaymentFlow getPaymentFlow(PaymentPayload payload, PaymentRequirements requirements) {
    SchemeNetworkServer scheme = getRegisteredScheme(requirements.network(), requirements.scheme());
    if (scheme == null) {
      throw new IllegalStateException("[x402] No server implementation registered for scheme: "
          + requirements.scheme() + ", network: " + requirements.network());
    }
    return PaymentFlows.resolve(scheme, requirements).flow();
  }

  // ---------------------------------------------------------------- verify

  /**
   * Verifies with routing by kind ({@link FacilitatorRoute#auto()}) and the current snapshot.
   *
   * @param payload the payment
   * @param requirements the matched requirements
   * @param declaredExtensions the route's extension declarations, may be {@code null}
   * @param transportContext transport data, may be {@code null}
   * @return the outcome
   */
  public ServerVerifyResult verifyPayment(
      PaymentPayload payload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      Object transportContext) {
    return verifyPayment(payload, requirements, declaredExtensions, transportContext,
        FacilitatorRoute.auto(), null);
  }

  /**
   * Verifies a payment at the facilitator chosen by {@code route}. Before-verify hooks always
   * run; the facilitator is called only when the flow verifies before the handler. Throwing hooks
   * are logged and skipped.
   *
   * @param payload the payment
   * @param requirements the matched requirements
   * @param declaredExtensions the route's extension declarations, may be {@code null}
   * @param transportContext transport data, may be {@code null}
   * @param route how to pick the facilitator
   * @param snap the snapshot to route with, or {@code null} for the current one
   * @return the outcome, with {@code verifiedBy} naming the facilitator that answered
   */
  public ServerVerifyResult verifyPayment(
      PaymentPayload payload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      Object transportContext,
      FacilitatorRoute route,
      RoutingSnapshot snap) {
    Map<String, Object> declared = declaredExtensions == null ? Map.of() : declaredExtensions;
    VerifyContext context = new VerifyContext(payload, requirements, declared, transportContext);
    for (Labeled<BeforeVerifyHook> h : hooks("beforeVerify", beforeVerifyHooks,
        SchemeServerHooks::onBeforeVerify, (ext, decl) -> c -> ext.onBeforeVerify(decl, c),
        declared, requirements)) {
      BeforeResult<VerifyResponse> result;
      try {
        result = h.hook().apply(context);
      } catch (RuntimeException e) {
        warnHook("beforeVerify", h.label(), e);
        continue;
      }
      if (result instanceof Abort a) {
        return new ServerVerifyResult(VerifyResponse.invalid(a.reason(), a.message()), null, null);
      }
      if (result instanceof Skip<VerifyResponse> s) {
        return runAfterVerifyHooks(s.result(), context, null);
      }
    }
    if (!getPaymentFlow(payload, requirements).verifyBeforeHandler()) {
      return new ServerVerifyResult(VerifyResponse.valid(null), null, null);
    }
    try {
      Answer<VerifyResponse> answer = callVerify(payload, requirements,
          route == null ? FacilitatorRoute.auto() : route, resolve(snap));
      return runAfterVerifyHooks(answer.value(), context, answer.by());
    } catch (RuntimeException error) {
      VerifyFailureContext failure = new VerifyFailureContext(payload, requirements, declared,
          transportContext, error);
      for (Labeled<OnVerifyFailureHook> h : hooks("onVerifyFailure", onVerifyFailureHooks,
          SchemeServerHooks::onVerifyFailure, (ext, decl) -> c -> ext.onVerifyFailure(decl, c),
          declared, requirements)) {
        Recovery<VerifyResponse> result;
        try {
          result = h.hook().apply(failure);
        } catch (RuntimeException e) {
          warnHook("onVerifyFailure", h.label(), e);
          continue;
        }
        if (result instanceof Recovered<VerifyResponse> r) {
          return runAfterVerifyHooks(r.value(), context, null);
        }
      }
      throw error;
    }
  }

  private Answer<VerifyResponse> callVerify(
      PaymentPayload payload, PaymentRequirements requirements, FacilitatorRoute route,
      RoutingSnapshot snap) {
    if (route instanceof Pinned p) {
      String id = requireKnown(p.identifier());
      return verifyAt(id, payload, requirements);
    }
    int version = payload.x402Version();
    String owner = snap == null ? null
        : snap.owner(version, requirements.network(), requirements.scheme());
    if (owner == null) {
      // No known owner (defensive): try every facilitator in order.
      RuntimeException last = null;
      for (String id : facilitators.keySet()) {
        try {
          return verifyAt(id, payload, requirements);
        } catch (RuntimeException e) {
          last = e;
        }
      }
      throw last != null ? last : new IllegalStateException(noFacilitator(requirements, version));
    }
    try {
      return verifyAt(owner, payload, requirements);
    } catch (RuntimeException e) {
      if (!(route instanceof AutoWithVerifyFailover) || !isTransportFailure(e)) {
        throw e;
      }
      String candidate = failoverCandidate(snap, owner, version, requirements);
      if (candidate == null) {
        throw e;
      }
      LOG.log(Level.WARNING, "[x402] verify on facilitator \"" + owner + "\" failed at transport "
          + "level (" + e.getMessage() + "); failing over once to \"" + candidate + "\"");
      return verifyAt(candidate, payload, requirements);
    }
  }

  private Answer<VerifyResponse> verifyAt(
      String id, PaymentPayload payload, PaymentRequirements requirements) {
    VerifyResponse response = facilitators.get(id).verify(payload, requirements);
    LOG.log(Level.DEBUG, () -> "[x402] verify via facilitator \"" + id + "\" on "
        + requirements.network() + ": isValid=" + response.isValid());
    return new Answer<>(response, id);
  }

  /**
   * Whether an error is a transport-level verify failure that may fail over: no response or a
   * timeout, or HTTP 5xx / 429 without a verdict body. Verdict bodies ({@code
   * VerifyException}), other 4xx and unusable 2xx bodies are final.
   *
   * @param e the error
   * @return {@code true} when failover is allowed
   */
  static boolean isTransportFailure(Throwable e) {
    if (e instanceof FacilitatorResponseException f) {
      int status = f.statusCode();
      return status == 0 || status == 429 || status >= 500;
    }
    if (e instanceof FacilitatorStatusException s) {
      return s.statusCode() == 429 || s.statusCode() >= 500;
    }
    return false;
  }

  private String failoverCandidate(
      RoutingSnapshot snap, String owner, int version, PaymentRequirements requirements) {
    List<String> candidates = failoverCandidates(snap, owner, version, requirements.network(),
        requirements.scheme());
    return candidates.isEmpty() ? null : candidates.get(0);
  }

  private static Map<String, Object> extraOf(SupportedKind kind) {
    return kind.extra() == null ? Map.of() : kind.extra();
  }

  private ServerVerifyResult runAfterVerifyHooks(
      VerifyResponse result, VerifyContext context, String verifiedBy) {
    VerifyResultContext resultContext = new VerifyResultContext(context.paymentPayload(),
        context.requirements(), context.declaredExtensions(), context.transportContext(), result);
    SkipHandlerDirective skip = null;
    for (Labeled<AfterVerifyHook> h : hooks("afterVerify", afterVerifyHooks,
        SchemeServerHooks::onAfterVerify, (ext, decl) -> c -> ext.onAfterVerify(decl, c),
        context.declaredExtensions(), context.requirements())) {
      AfterVerifyResult directive;
      try {
        directive = h.hook().apply(resultContext);
      } catch (RuntimeException e) {
        warnHook("afterVerify", h.label(), e);
        continue;
      }
      if (directive instanceof Abort a) {
        dispatchCanceled(context.paymentPayload(), context.requirements(),
            context.declaredExtensions(),
            new CancelOptions(CancellationReason.AFTER_VERIFY_ABORTED, null, null),
            context.transportContext(), List.of(), null);
        return new ServerVerifyResult(VerifyResponse.invalid(a.reason(), a.message()), null,
            verifiedBy);
      }
      if (directive instanceof SkipHandler s) {
        skip = s.response() == null ? new SkipHandlerDirective(null, null) : s.response();
      }
    }
    return new ServerVerifyResult(result, skip, verifiedBy);
  }

  // ---------------------------------------------------------------- settle

  /**
   * Settles with routing by kind and the current snapshot.
   *
   * @param payload the payment
   * @param requirements the requirements
   * @param declaredExtensions the route's extension declarations, may be {@code null}
   * @param transportContext transport data, may be {@code null}
   * @param overrides settlement overrides, may be {@code null}
   * @param phase the settle phase, {@code null} for after-handler
   * @return the result
   */
  public SettleResponse settlePayment(
      PaymentPayload payload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      Object transportContext,
      SettlementOverrides overrides,
      SettlePhase phase) {
    return settlePayment(payload, requirements, declaredExtensions, transportContext, overrides,
        phase, SettlementRouting.auto());
  }

  /**
   * Settles a payment: overrides, before-settle hooks (an abort throws a 400
   * {@link SettleException}), payload enrichment, settle with one pending retry ({@code
   * settleWithPendingRetry}) at the settle target, failure hooks for thrown errors and
   * for returned {@code success:false} results, after hooks, response enrichment.
   *
   * @param payload the payment
   * @param requirements the requirements
   * @param declaredExtensions the route's extension declarations, may be {@code null}
   * @param transportContext transport data, may be {@code null}
   * @param overrides settlement overrides, may be {@code null}
   * @param phase the settle phase, {@code null} for after-handler
   * @param routing where to settle: {@code verifiedBy}, else the pin, else the build facilitator
   * @return the result
   * @throws SettleException when a before-settle hook aborts, or the facilitator's error
   */
  public SettleResponse settlePayment(
      PaymentPayload payload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      Object transportContext,
      SettlementOverrides overrides,
      SettlePhase phase,
      SettlementRouting routing) {
    Map<String, Object> declared = declaredExtensions == null ? Map.of() : declaredExtensions;
    SettlePhase resolvedPhase = phase == null ? SettlePhase.AFTER_HANDLER : phase;
    PaymentRequirements effective = requirements;
    if (overrides != null && overrides.amount() != null) {
      Integer decimals = null;
      if (SettlementOverrides.isDollar(overrides.amount())) {
        SchemeNetworkServer scheme =
            getRegisteredScheme(requirements.network(), requirements.scheme());
        decimals = scheme == null ? null : scheme.getAssetDecimals(
            requirements.asset() == null ? "" : requirements.asset(), requirements.network());
      }
      effective = requirements.withAmount(
          SettlementOverrides.resolveAmount(overrides.amount(), requirements, decimals));
    }
    SettleContext context =
        new SettleContext(payload, effective, declared, resolvedPhase, transportContext);
    for (Labeled<BeforeSettleHook> h : hooks("beforeSettle", beforeSettleHooks,
        SchemeServerHooks::onBeforeSettle, (ext, decl) -> c -> ext.onBeforeSettle(decl, c),
        declared, effective)) {
      BeforeResult<SettleResponse> result;
      try {
        result = h.hook().apply(context);
      } catch (RuntimeException e) {
        warnHook("beforeSettle", h.label(), e);
        continue;
      }
      if (result instanceof Abort a) {
        throw new SettleException(400,
            SettleResponse.failure(a.reason(), a.message(), "", requirements.network()));
      }
      if (result instanceof Skip<SettleResponse> s) {
        SettleResultContext skipped = resultContext(context, s.result());
        runAfterSettle(skipped);
        return enrichSettlementResponse(s.result(), skipped);
      }
    }
    try {
      SchemeNetworkServer scheme = getRegisteredScheme(effective.network(), effective.scheme());
      PaymentPayload settlePayload = payload;
      if (scheme != null) {
        Map<String, Object> enrichment = scheme.enrichSettlementPayload(context);
        if (enrichment != null) {
          HookPolicy.assertAdditivePayloadEnrichment(payload.payload(), enrichment,
              "scheme \"" + effective.scheme() + "\" enrichSettlementPayload");
          Map<String, Object> merged = new LinkedHashMap<>(payload.payload());
          merged.putAll(enrichment);
          settlePayload = new PaymentPayload(payload.x402Version(), payload.resource(),
              payload.accepted(), merged, payload.extensions());
        }
      }
      String target = settleTarget(routing == null ? SettlementRouting.auto() : routing,
          settlePayload.x402Version(), effective);
      SettleResponse result = settleWithPendingRetry(target, settlePayload, effective);
      if (!result.success()) {
        SettleFailureContext failure = new SettleFailureContext(payload, effective, declared,
            resolvedPhase, transportContext, settleResponseToError(result));
        SettleResponse recovered = runSettleFailureHooks(failure);
        return recovered != null ? recovered : result;
      }
      SettleResultContext done = resultContext(context, result);
      runAfterSettle(done);
      return enrichSettlementResponse(result, done);
    } catch (RuntimeException error) {
      SettleResponse recovered = runSettleFailureHooks(new SettleFailureContext(payload,
          effective, declared, resolvedPhase, transportContext, error));
      if (recovered != null) {
        return recovered;
      }
      throw error;
    }
  }

  private String settleTarget(SettlementRouting routing, int version, PaymentRequirements req) {
    if (routing.verifiedBy() != null) {
      return requireKnown(routing.verifiedBy());
    }
    if (routing.route() instanceof Pinned p) {
      return requireKnown(p.identifier());
    }
    RoutingSnapshot snap = resolve(routing.snapshot());
    String owner = snap == null ? null : snap.owner(version, req.network(), req.scheme());
    if (owner == null) {
      throw new IllegalStateException(noFacilitator(req, version));
    }
    return owner;
  }

  private SettleResponse settleWithPendingRetry(
      String id, PaymentPayload payload, PaymentRequirements requirements) {
    FacilitatorClient client = facilitators.get(id);
    SettleResponse result = null;
    boolean retry;
    try {
      result = client.settle(payload, requirements);
      retry = isRetryablePending(result);
    } catch (SettleException e) {
      if (!isRetryablePending(e.response())) {
        throw e;
      }
      retry = true;
    }
    if (!retry) {
      LOG.log(Level.INFO, "[x402] settle via facilitator \"" + id + "\" on "
          + requirements.network() + ": success=" + result.success());
      return result;
    }
    LOG.log(Level.INFO, "[x402] settle via facilitator \"" + id + "\" is pending; retrying once");
    SettleResponse second = client.settle(payload, requirements);
    LOG.log(Level.INFO, "[x402] settle retry via facilitator \"" + id + "\": success="
        + second.success());
    return second;
  }

  private static boolean isRetryablePending(SettleResponse r) {
    return r != null && r.isPending() && r.transaction() != null && !r.transaction().isEmpty();
  }

  private static SettleException settleResponseToError(SettleResponse r) {
    String reason = r.errorReason() == null || r.errorReason().isEmpty() ? "Settlement failed"
        : r.errorReason();
    return new SettleException(500, new SettleResponse(false, reason, r.errorMessage(), r.payer(),
        r.transaction(), r.network(), r.amount(), r.extensions(), r.extensionResponses(),
        r.extra()));
  }

  private SettleResponse runSettleFailureHooks(SettleFailureContext failure) {
    for (Labeled<OnSettleFailureHook> h : hooks("onSettleFailure", onSettleFailureHooks,
        SchemeServerHooks::onSettleFailure, (ext, decl) -> c -> ext.onSettleFailure(decl, c),
        failure.declaredExtensions(), failure.requirements())) {
      Recovery<SettleResponse> result;
      try {
        result = h.hook().apply(failure);
      } catch (RuntimeException e) {
        warnHook("onSettleFailure", h.label(), e);
        continue;
      }
      if (result instanceof Recovered<SettleResponse> r) {
        return r.value();
      }
    }
    return null;
  }

  private void runAfterSettle(SettleResultContext context) {
    for (Labeled<AfterSettleHook> h : hooks("afterSettle", afterSettleHooks,
        SchemeServerHooks::onAfterSettle, (ext, decl) -> c -> ext.onAfterSettle(decl, c),
        context.declaredExtensions(), context.requirements())) {
      try {
        h.hook().apply(context);
      } catch (RuntimeException e) {
        warnHook("afterSettle", h.label(), e);
      }
    }
  }

  private static SettleResultContext resultContext(SettleContext c, SettleResponse result) {
    return new SettleResultContext(c.paymentPayload(), c.requirements(), c.declaredExtensions(),
        c.phase(), c.transportContext(), result);
  }

  private SettleResponse enrichSettlementResponse(SettleResponse result, SettleResultContext ctx) {
    SettleResponse current = result;
    for (Map.Entry<String, Object> e : ctx.declaredExtensions().entrySet()) {
      ResourceServerExtension ext = extensions.get(e.getKey());
      if (ext == null) {
        continue;
      }
      try {
        Object data = ext.enrichSettlementResponse(e.getValue(), ctx);
        if (data != null) {
          Map<String, Object> exts = new LinkedHashMap<>();
          if (current.extensions() != null) {
            exts.putAll(current.extensions());
          }
          exts.put(e.getKey(), data);
          current = new SettleResponse(current.success(), current.errorReason(),
              current.errorMessage(), current.payer(), current.transaction(), current.network(),
              current.amount(), exts, current.extensionResponses(), current.extra());
        }
      } catch (RuntimeException ex) {
        warnExtension(e.getKey(), "enrichSettlementResponse", ex);
      }
    }
    PaymentRequirements req = ctx.requirements();
    SchemeNetworkServer scheme = getRegisteredScheme(req.network(), req.scheme());
    if (scheme == null) {
      return current;
    }
    String label = "scheme \"" + req.scheme() + "\" enrichSettlementResponse";
    try {
      Map<String, Object> enrichment = scheme.enrichSettlementResponse(
          resultContext(new SettleContext(ctx.paymentPayload(), req, ctx.declaredExtensions(),
              ctx.phase(), ctx.transportContext()), current));
      if (enrichment == null) {
        return current;
      }
      Map<String, Object> extra = current.extra() == null ? Map.of() : current.extra();
      HookPolicy.assertAdditiveSettlementExtra(extra, enrichment, label);
      return new SettleResponse(current.success(), current.errorReason(), current.errorMessage(),
          current.payer(), current.transaction(), current.network(), current.amount(),
          current.extensions(), current.extensionResponses(),
          HookPolicy.mergeAdditive(extra, enrichment));
    } catch (RuntimeException e) {
      warnHook("enrichSettlementResponse", label, e);
      return current;
    }
  }

  // ---------------------------------------------------------------- cancel

  /**
   * Creates a once-only cancel for a payment that
   * passed the pre-handler gates. A settle-on-cancel uses the same {@code routing} as the
   * payment's other settles.
   *
   * @param payload the payment
   * @param requirements the matched requirements
   * @param declaredExtensions the route's extension declarations, may be {@code null}
   * @param transportContext transport data, may be {@code null}
   * @param settledPhases phases already settled (e.g. before-handler)
   * @param routing where a settle-on-cancel goes
   * @return the dispatcher
   */
  public PaymentCancellationDispatcher createPaymentCancellationDispatcher(
      PaymentPayload payload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      Object transportContext,
      List<SettlePhase> settledPhases,
      SettlementRouting routing) {
    Map<String, Object> declared = declaredExtensions == null ? Map.of() : declaredExtensions;
    List<SettlePhase> phases = settledPhases == null ? List.of() : List.copyOf(settledPhases);
    return new PaymentCancellationDispatcher() {
      private boolean dispatched;
      private SettleResponse result;

      @Override
      public synchronized SettleResponse cancel(CancelOptions options) {
        if (!dispatched) {
          dispatched = true;
          result = dispatchCanceled(payload, requirements, declared, options, transportContext,
              phases, routing);
        }
        return result;
      }
    };
  }

  private SettleResponse dispatchCanceled(
      PaymentPayload payload,
      PaymentRequirements requirements,
      Map<String, Object> declared,
      CancelOptions options,
      Object transportContext,
      List<SettlePhase> settledPhases,
      SettlementRouting routing) {
    VerifiedPaymentCanceledContext context = new VerifiedPaymentCanceledContext(payload,
        requirements, declared, SettlePhase.CANCEL, transportContext, options.reason(),
        options.error(), options.responseStatus(), settledPhases);
    for (Labeled<OnVerifiedPaymentCanceledHook> h : hooks("onVerifiedPaymentCanceled",
        onCanceledHooks, SchemeServerHooks::onVerifiedPaymentCanceled,
        (ext, decl) -> c -> ext.onVerifiedPaymentCanceled(decl, c), declared, requirements)) {
      try {
        h.hook().apply(context);
      } catch (RuntimeException e) {
        warnHook("onVerifiedPaymentCanceled", h.label(), e);
      }
    }
    SchemeNetworkServer scheme = getRegisteredScheme(requirements.network(), requirements.scheme());
    if (scheme == null || !settledPhases.contains(SettlePhase.BEFORE_HANDLER)) {
      return null;
    }
    String label = "scheme \"" + requirements.scheme() + "\" settleOnCancel";
    try {
      PaymentRequirements cancelRequirements = scheme.settleOnCancel(context);
      if (cancelRequirements == null) {
        return null;
      }
      return settlePayment(payload, cancelRequirements, declared, transportContext, null,
          SettlePhase.CANCEL, routing == null ? SettlementRouting.auto() : routing);
    } catch (RuntimeException e) {
      warnHook("settleOnCancel", label, e);
      String message = e.getMessage() == null ? e.toString() : e.getMessage();
      if (e instanceof SettleException se) {
        String reason = se.response().errorReason();
        return new SettleResponse(false, reason == null ? message : reason,
            se.response().errorMessage(), null, "", requirements.network(), null, null, null,
            null);
      }
      return new SettleResponse(false, message, null, null, "", requirements.network(), null,
          null, null, null);
    }
  }

  // ---------------------------------------------------------------- helpers

  private record Labeled<H>(String label, H hook) {}

  private record Answer<T>(T value, String by) {}

  /**
   * Manual hooks first, then the matched scheme's hook, then hooks of declared extensions in
   * registration order.
   */
  private <H> List<Labeled<H>> hooks(
      String phase,
      List<H> manual,
      Function<SchemeServerHooks, H> schemePick,
      BiFunction<ResourceServerExtension, Object, H> extensionAdapter,
      Map<String, Object> declared,
      PaymentRequirements requirements) {
    List<Labeled<H>> out = new ArrayList<>(manual.size() + 2);
    for (int i = 0; i < manual.size(); i++) {
      out.add(new Labeled<>("manual " + phase + " hook #" + i, manual.get(i)));
    }
    SchemeServerHooks scheme =
        Networks.findByNetworkAndScheme(schemeHooks, requirements.scheme(), requirements.network());
    H schemeHook = scheme == null ? null : schemePick.apply(scheme);
    if (schemeHook != null) {
      out.add(new Labeled<>("scheme \"" + requirements.scheme() + "\" " + phase, schemeHook));
    }
    if (!declared.isEmpty()) {
      extensions.forEach((key, ext) -> {
        if (declared.containsKey(key)) {
          out.add(new Labeled<>("extension \"" + key + "\" " + phase,
              extensionAdapter.apply(ext, declared.get(key))));
        }
      });
    }
    return out;
  }

  private String requireKnown(String identifier) {
    String id = Identifiers.normalize(identifier);
    if (!facilitators.containsKey(id)) {
      throw new IllegalArgumentException("Unknown facilitator \"" + identifier + "\"; known: "
          + String.join(", ", facilitators.keySet()));
    }
    return id;
  }

  private RoutingSnapshot resolve(RoutingSnapshot snap) {
    return snap != null ? snap : snapshot.get();
  }

  private void freeze() {
    synchronized (registrationLock) {
      frozen = true;
    }
  }

  private static String noFacilitator(PaymentRequirements r, int version) {
    return "No facilitator supports " + r.scheme() + " on " + r.network() + " for v" + version;
  }

  private static void warnHook(String phase, String label, RuntimeException e) {
    LOG.log(Level.WARNING, "[x402] Resource server " + phase + " hook threw (" + label + "): "
        + (e.getMessage() == null ? e.toString() : e.getMessage()));
  }

  private static void warnExtension(String key, String hook, RuntimeException e) {
    LOG.log(Level.WARNING, "[x402] extension \"" + key + "\" " + hook + " threw: "
        + (e.getMessage() == null ? e.toString() : e.getMessage()));
  }

  private static <T> Map<String, Map<String, T>> copy(Map<String, Map<String, T>> source) {
    Map<String, Map<String, T>> out = new LinkedHashMap<>();
    source.forEach((k, v) -> out.put(k, new LinkedHashMap<>(v)));
    return out;
  }

  private static <T> Map<String, Map<String, T>> freezeNested(Map<String, Map<String, T>> source) {
    Map<String, Map<String, T>> out = new LinkedHashMap<>();
    source.forEach((k, v) -> out.put(k, Collections.unmodifiableMap(v)));
    return Collections.unmodifiableMap(out);
  }
}
