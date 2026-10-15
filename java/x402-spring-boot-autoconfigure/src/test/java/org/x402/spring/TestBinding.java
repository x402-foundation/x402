package org.x402.spring;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.ConfigurationPropertySource;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.boot.convert.ApplicationConversionService;
import org.x402.spring.properties.PriceSpecConverter;
import org.x402.spring.properties.RawProperties;
import org.x402.spring.properties.X402Properties;

/** Binds {@link X402Properties} from flat key/value pairs, as Spring does from YAML. */
public final class TestBinding {

  private TestBinding() {}

  /**
   * The bound properties and the raw-presence predicate over the same source.
   *
   * @param properties the properties
   * @param present whether a raw property (or a descendant) is set
   */
  public record Bound(X402Properties properties, Predicate<String> present) {}

  /**
   * Binds {@code x402.*} from key/value pairs.
   *
   * @param kv alternating keys and values
   * @return the binding
   */
  public static Bound bind(String... kv) {
    Map<String, Object> map = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      map.put(kv[i], kv[i + 1]);
    }
    MapConfigurationPropertySource source = new MapConfigurationPropertySource(map);
    ApplicationConversionService conversion = new ApplicationConversionService();
    conversion.addConverter(new PriceSpecConverter());
    List<ConfigurationPropertySource> sources = List.of(source);
    Binder binder = new Binder(sources, null, conversion);
    X402Properties properties = binder.bindOrCreate("x402", Bindable.of(X402Properties.class));
    return new Bound(properties, RawProperties.presence(sources));
  }
}
