package org.x402.spring.autoconfigure;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Predicate;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.ConfigurationPropertyName;
import org.springframework.boot.context.properties.source.ConfigurationPropertyName.Form;
import org.springframework.boot.context.properties.source.ConfigurationPropertySource;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.context.properties.source.IterableConfigurationPropertySource;
import org.springframework.core.env.Environment;
import org.springframework.util.ClassUtils;
import org.x402.spring.X402ConfigurationException;

/**
 * Fails startup when configuration names a payment mechanism whose module is not on the
 * classpath. The starter brings no mechanism; an application adds the ones it uses, and a missing
 * one would otherwise start silently: a server whose routes answer 503, a client that can't pay,
 * a facilitator that supports nothing.
 *
 * <p>Reads plain properties only, so it never links against a mechanism's classes.
 */
public final class X402MechanismCheck {

  /**
   * A mechanism the starter knows how to wire.
   *
   * @param name the name in error messages
   * @param artifact the Maven coordinates to add
   * @param probeClass a class of the mechanism module
   * @param network whether a CAIP-2 network belongs to the mechanism
   * @param clientNetworks the property listing the client's networks
   * @param facilitatorNetworks the property listing the facilitator's networks
   */
  record Mechanism(String name, String artifact, String probeClass, Predicate<String> network,
      String clientNetworks, String facilitatorNetworks) {}

  static final List<Mechanism> MECHANISMS = List.of(
      new Mechanism("Cardano", "org.x402:x402-mechanism-cardano",
          "org.x402.mechanisms.cardano.exact.server.ExactCardanoServerScheme",
          n -> n.startsWith("cardano:") || n.startsWith("cip34:"),
          "x402.client.cardano.networks", "x402.facilitator-server.cardano.networks"));

  private static final ConfigurationPropertyName ACCOUNTS = ConfigurationPropertyName.of("x402.accounts");
  private static final ConfigurationPropertyName ROUTES = ConfigurationPropertyName.of("x402.routes");

  private X402MechanismCheck() {}

  /**
   * Checks the configuration against the classpath.
   *
   * @param environment the application's environment
   * @param classLoader the class loader to probe
   * @throws X402ConfigurationException naming every missing mechanism and where it is configured
   */
  public static void check(Environment environment, ClassLoader classLoader) {
    Binder binder = Binder.get(environment);
    List<String> problems = new ArrayList<>();
    for (Mechanism m : MECHANISMS) {
      if (ClassUtils.isPresent(m.probeClass(), classLoader)) {
        continue;
      }
      List<String> uses = uses(environment, binder, m);
      if (!uses.isEmpty()) {
        problems.add(m.name() + " is configured (" + String.join(", ", uses) + ") but "
            + m.artifact() + " is not on the classpath; add it as a dependency");
      }
    }
    if (!problems.isEmpty()) {
      throw new X402ConfigurationException(String.join("; ", problems));
    }
  }

  private static List<String> uses(Environment environment, Binder binder, Mechanism m) {
    // Only what would actually be wired: a resource server (x402.enabled, default on), a client
    // (x402.client.enabled, default off), a facilitator (x402.facilitator-server.enabled).
    boolean server = binder.bind("x402.enabled", Boolean.class).orElse(true);
    boolean client = binder.bind("x402.client.enabled", Boolean.class).orElse(false);
    boolean facilitator = binder.bind("x402.facilitator-server.enabled", Boolean.class)
        .orElse(false);
    ConfigurationPropertyName clientNetworks = ConfigurationPropertyName.of(m.clientNetworks());
    ConfigurationPropertyName facilitatorNetworks =
        ConfigurationPropertyName.of(m.facilitatorNetworks());
    Set<String> uses = new TreeSet<>();
    // Property names compared as ConfigurationPropertyName, as the binder does: dashes, case,
    // camelCase, environment variables and bracketed map keys all match.
    for (ConfigurationPropertyName name : propertyNames(environment)) {
      if (server && (isAccountNetwork(name) || isOptionNetwork(name))) {
        String network = binder.bind(name, Bindable.of(String.class)).orElse(null);
        if (network != null && m.network().test(network.strip())) {
          uses.add(name.toString());
        }
      } else if (client && clientNetworks.isAncestorOf(name)) {
        uses.add(m.clientNetworks());
      } else if (facilitator && facilitatorNetworks.isAncestorOf(name)) {
        uses.add(m.facilitatorNetworks());
      }
    }
    return new ArrayList<>(uses);
  }

  /** {@code x402.accounts.NAME.network}. */
  private static boolean isAccountNetwork(ConfigurationPropertyName name) {
    return ACCOUNTS.isAncestorOf(name) && name.getNumberOfElements() == 4
        && "network".equals(name.getElement(3, Form.UNIFORM));
  }

  /** {@code x402.routes.NAME.accepts[N].network}. */
  private static boolean isOptionNetwork(ConfigurationPropertyName name) {
    return ROUTES.isAncestorOf(name) && name.getNumberOfElements() == 6
        && "accepts".equals(name.getElement(3, Form.UNIFORM)) && name.isNumericIndex(4)
        && "network".equals(name.getElement(5, Form.UNIFORM));
  }

  /** Names from every source that can list them; a custom unlisted source is not seen. */
  private static Set<ConfigurationPropertyName> propertyNames(Environment environment) {
    ConfigurationPropertyName root = ConfigurationPropertyName.of("x402");
    Set<ConfigurationPropertyName> names = new LinkedHashSet<>();
    for (ConfigurationPropertySource source : ConfigurationPropertySources.get(environment)) {
      if (source instanceof IterableConfigurationPropertySource iterable) {
        iterable.stream().filter(root::isAncestorOf).forEach(names::add);
      }
    }
    return names;
  }
}
