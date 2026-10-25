package org.x402.examples.server;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.boot.context.properties.bind.BindHandler;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.bind.PlaceholdersResolver;
import org.springframework.boot.context.properties.bind.handler.IgnoreTopLevelConverterNotFoundBindHandler;
import org.springframework.boot.context.properties.bind.handler.NoUnboundElementsBindHandler;
import org.springframework.boot.context.properties.source.ConfigurationPropertyName;
import org.springframework.boot.context.properties.source.ConfigurationPropertySource;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.EnumerablePropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ByteArrayResource;
import org.x402.spring.cardano.X402CardanoProperties;
import org.x402.spring.facilitator.X402FacilitatorServerProperties;
import org.x402.spring.properties.PriceSpecConverter;
import org.x402.spring.properties.X402Properties;

/**
 * Binds YAML through the SDK's real {@code x402.*} properties classes and fails on any key none of
 * them binds. Three classes share the prefix: {@link X402Properties} (everything except the
 * Cardano account blocks and the facilitator server), {@link X402CardanoProperties} ({@code
 * x402.accounts.*.network} and {@code x402.accounts.*.cardano.*}) and {@link
 * X402FacilitatorServerProperties} ({@code x402.facilitator-server.*}). Each is bound over the
 * slice of names it owns with Spring's {@link NoUnboundElementsBindHandler}, the handler behind
 * {@code ignoreUnknownFields = false}, so a typo or a key that moved fails here.
 */
final class StrictX402Binding {

  private static final Pattern PLACEHOLDER = Pattern.compile("\\$\\{([^}:]+)(?::([^}]*))?}");

  /** The result of one strict binding. */
  record Bound(X402Properties x402, X402CardanoProperties cardano,
      X402FacilitatorServerProperties facilitatorServer, Map<String, Object> flattened) {}

  private StrictX402Binding() {}

  /**
   * Binds a YAML document.
   *
   * @param yaml the YAML text
   * @param placeholders values for {@code ${NAME}} placeholders without a default (others resolve
   *     to their default, or to the placeholder name)
   * @return the bound properties
   */
  static Bound bind(String yaml, Map<String, String> placeholders) {
    List<PropertySource<?>> loaded;
    try {
      loaded = new YamlPropertySourceLoader().load("snippet",
          new ByteArrayResource(yaml.getBytes(StandardCharsets.UTF_8)));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    Map<String, Object> flattened = new java.util.LinkedHashMap<>();
    for (PropertySource<?> source : loaded) {
      if (source instanceof EnumerablePropertySource<?> e) {
        for (String name : e.getPropertyNames()) {
          flattened.put(name, e.getProperty(name));
        }
      }
    }
    List<ConfigurationPropertySource> sources = new ArrayList<>();
    ConfigurationPropertySources.from(loaded).forEach(sources::add);

    ApplicationConversionService conversion = new ApplicationConversionService();
    conversion.addConverter(new PriceSpecConverter());
    PlaceholdersResolver resolver = value -> value instanceof String s
        ? resolve(s, placeholders) : value;

    X402Properties x402 = binder(sources, n -> isUnder(n, "x402")
            && !isCardanoAccountBlock(n) && !isUnder(n, "x402.client.cardano")
            && !isUnder(n, "x402.facilitator-server"),
        resolver, conversion)
        .bindOrCreate("x402", Bindable.of(X402Properties.class), strict());
    X402CardanoProperties cardano = binder(sources,
        n -> isCardanoAccountBlock(n) || isAccountNetwork(n) || isUnder(n, "x402.client.cardano"),
        resolver, conversion)
        .bindOrCreate("x402", Bindable.of(X402CardanoProperties.class), strict());
    X402FacilitatorServerProperties facilitator = binder(sources,
        n -> isUnder(n, "x402.facilitator-server"), resolver, conversion)
        .bindOrCreate("x402.facilitator-server",
            Bindable.of(X402FacilitatorServerProperties.class), strict());
    return new Bound(x402, cardano, facilitator, flattened);
  }

  /**
   * The flattened {@code x402.*} keys of a YAML document, in Spring's form ({@code a.b[0].c}).
   *
   * @param yaml the YAML text
   * @return the keys
   */
  static Set<String> keys(String yaml) {
    Set<String> keys = new LinkedHashSet<>();
    for (String key : bind(yaml, Map.of()).flattened().keySet()) {
      if (key.startsWith("x402.")) {
        keys.add(key);
      }
    }
    return keys;
  }

  private static BindHandler strict() {
    return new NoUnboundElementsBindHandler(new IgnoreTopLevelConverterNotFoundBindHandler());
  }

  private static Binder binder(List<ConfigurationPropertySource> sources,
      Predicate<ConfigurationPropertyName> owned, PlaceholdersResolver resolver,
      ApplicationConversionService conversion) {
    List<ConfigurationPropertySource> filtered = sources.stream()
        .map(s -> s.filter(owned)).toList();
    return new Binder(filtered, resolver, conversion);
  }

  private static boolean isUnder(ConfigurationPropertyName name, String prefix) {
    ConfigurationPropertyName p = ConfigurationPropertyName.of(prefix);
    return p.equals(name) || p.isAncestorOf(name);
  }

  /** {@code x402.accounts.<name>.cardano[.…]}. */
  private static boolean isCardanoAccountBlock(ConfigurationPropertyName name) {
    return name.getNumberOfElements() >= 4 && isUnder(name, "x402.accounts")
        && "cardano".equals(name.getElement(3, ConfigurationPropertyName.Form.UNIFORM));
  }

  /** {@code x402.accounts.<name>.network}, also read by the Cardano properties. */
  private static boolean isAccountNetwork(ConfigurationPropertyName name) {
    return name.getNumberOfElements() == 4 && isUnder(name, "x402.accounts")
        && "network".equals(name.getElement(3, ConfigurationPropertyName.Form.UNIFORM));
  }

  private static String resolve(String value, Map<String, String> placeholders) {
    Matcher m = PLACEHOLDER.matcher(value);
    StringBuilder out = new StringBuilder();
    while (m.find()) {
      String replacement = m.group(2) != null ? m.group(2)
          : placeholders.getOrDefault(m.group(1), m.group(1));
      m.appendReplacement(out, Matcher.quoteReplacement(replacement));
    }
    m.appendTail(out);
    return out.toString();
  }
}
