package org.x402.core.server;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.x402.core.FacilitatorClient;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.SupportedResponse;
import org.x402.core.utils.Networks;

/**
 * One immutable result of a facilitator sync: what each facilitator answered on {@code
 * /supported}, which ones failed, and who owns each (version, network, scheme) kind. {@link
 * X402ResourceServer#initialize()} builds a new snapshot and publishes it with one atomic swap; a
 * published snapshot never changes, so a request that captured one routes consistently.
 *
 * <p>Answers are applied in declaration order and the first facilitator listing a kind
 * owns it; a failed facilitator's kept answer is applied after every live one, so it only owns
 * kinds that no live facilitator lists. Lookups: an exact network key wins over a wildcard key, and an exact key without
 * the scheme does not fall back to the pattern.
 */
public final class RoutingSnapshot {

  private final long generation;
  private final Map<String, FacilitatorClient> clients;
  private final Map<String, SupportedResponse> supported;
  private final Map<String, Throwable> failures;
  private final Map<Integer, Map<String, Map<String, String>>> owners;

  private RoutingSnapshot(
      long generation,
      Map<String, FacilitatorClient> clients,
      Map<String, SupportedResponse> supported,
      Map<String, Throwable> failures,
      Map<Integer, Map<String, Map<String, String>>> owners) {
    this.generation = generation;
    this.clients = clients;
    this.supported = supported;
    this.failures = failures;
    this.owners = owners;
  }

  /**
   * Builds a snapshot from sync results.
   *
   * @param generation a monotonically increasing number
   * @param clients identifier → client, in declaration order
   * @param answers identifier → {@code /supported} answer, for the facilitators that answered
   *     (or a failing facilitator's last good answer)
   * @param failures identifier → error, for the facilitators that failed
   * @return the snapshot
   */
  static RoutingSnapshot build(
      long generation,
      Map<String, FacilitatorClient> clients,
      Map<String, SupportedResponse> answers,
      Map<String, Throwable> failures) {
    Map<String, SupportedResponse> ordered = new LinkedHashMap<>();
    Map<Integer, Map<String, Map<String, String>>> owners = new LinkedHashMap<>();
    for (String id : clients.keySet()) {
      SupportedResponse answer = answers.get(id);
      if (answer != null) {
        ordered.put(id, answer);
      }
    }
    // Facilitators that answered now claim kinds first; a failed one's kept answer only fills
    // the kinds no live facilitator lists, so a dead facilitator never holds a kind another serves.
    for (boolean live : new boolean[] {true, false}) {
      ordered.forEach((id, answer) -> {
        if (failures.containsKey(id) == live) {
          return;
        }
        for (SupportedKind kind : answer.kinds()) {
          owners.computeIfAbsent(kind.x402Version(), v -> new LinkedHashMap<>())
              .computeIfAbsent(kind.network(), n -> new LinkedHashMap<>())
              .putIfAbsent(kind.scheme(), id);
        }
      });
    }
    Map<Integer, Map<String, Map<String, String>>> frozen = new LinkedHashMap<>();
    owners.forEach((version, byNetwork) -> {
      Map<String, Map<String, String>> networks = new LinkedHashMap<>();
      byNetwork.forEach((n, schemes) -> networks.put(n, Collections.unmodifiableMap(schemes)));
      frozen.put(version, Collections.unmodifiableMap(networks));
    });
    Map<String, Throwable> failed = new LinkedHashMap<>();
    clients.keySet().stream().filter(failures::containsKey)
        .forEach(id -> failed.put(id, failures.get(id)));
    return new RoutingSnapshot(generation,
        Collections.unmodifiableMap(new LinkedHashMap<>(clients)),
        Collections.unmodifiableMap(ordered), Collections.unmodifiableMap(failed),
        Collections.unmodifiableMap(frozen));
  }

  /**
   * The sync number; later syncs have larger numbers.
   *
   * @return the generation
   */
  public long generation() {
    return generation;
  }

  /**
   * All facilitator identifiers in declaration order.
   *
   * @return the identifiers
   */
  public List<String> facilitatorIdentifiers() {
    return List.copyOf(clients.keySet());
  }

  /**
   * A facilitator's {@code /supported} answer; for a facilitator that failed this sync, its last
   * good answer when it had one.
   *
   * @param identifier the identifier
   * @return the answer, or {@code null} when it never answered or is unknown
   */
  public SupportedResponse supported(String identifier) {
    return supported.get(identifier);
  }

  /**
   * The facilitators whose {@code /supported} failed in this sync, in declaration order.
   *
   * @return identifier → error
   */
  public Map<String, Throwable> failures() {
    return failures;
  }

  /**
   * Whether any facilitator listed at least one kind.
   *
   * @return {@code true} when some kind was loaded
   */
  public boolean hasKinds() {
    return !owners.isEmpty();
  }

  /**
   * The protocol versions that have kinds.
   *
   * @return the versions
   */
  public Set<Integer> versions() {
    return owners.keySet();
  }

  /**
   * The facilitator owning a kind, with network pattern lookup.
   *
   * @param x402Version the protocol version
   * @param network the network
   * @param scheme the scheme
   * @return the owner's identifier, or {@code null}
   */
  public String owner(int x402Version, String network, String scheme) {
    Map<String, Map<String, String>> byNetwork = owners.get(x402Version);
    return byNetwork == null ? null : Networks.findByNetworkAndScheme(byNetwork, scheme, network);
  }

  /**
   * The owner's exact kind; a wildcard kind never matches, so it
   * cannot build requirements.
   *
   * @param x402Version the protocol version
   * @param network the network
   * @param scheme the scheme
   * @return the kind, or {@code null}
   */
  public SupportedKind supportedKind(int x402Version, String network, String scheme) {
    String owner = owner(x402Version, network, scheme);
    return owner == null ? null : kindOf(owner, x402Version, network, scheme);
  }

  /**
   * The owner's extensions for a kind.
   *
   * @param x402Version the protocol version
   * @param network the network
   * @param scheme the scheme
   * @return the extension keys, possibly empty
   */
  public List<String> ownerExtensions(int x402Version, String network, String scheme) {
    String owner = owner(x402Version, network, scheme);
    return owner == null ? List.of() : extensions(owner);
  }

  /**
   * The exact kind a given facilitator listed.
   *
   * @param identifier the facilitator
   * @param x402Version the protocol version
   * @param network the network (matched exactly)
   * @param scheme the scheme
   * @return the kind, or {@code null}
   */
  public SupportedKind kindOf(String identifier, int x402Version, String network, String scheme) {
    SupportedResponse answer = supported.get(identifier);
    if (answer == null) {
      return null;
    }
    return answer.kinds().stream()
        .filter(k -> k.x402Version() == x402Version && k.network().equals(network)
            && k.scheme().equals(scheme))
        .findFirst().orElse(null);
  }

  /**
   * A facilitator's extension keys.
   *
   * @param identifier the facilitator
   * @return the keys, empty when it failed or listed none
   */
  public List<String> extensions(String identifier) {
    SupportedResponse answer = supported.get(identifier);
    return answer == null ? List.of() : answer.extensions();
  }

  @Override
  public String toString() {
    return "RoutingSnapshot{generation=" + generation + ", answered=" + supported.keySet()
        + ", failed=" + failures.keySet() + "}";
  }
}
