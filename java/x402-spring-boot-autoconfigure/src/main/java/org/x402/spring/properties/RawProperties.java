package org.x402.spring.properties;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import org.springframework.boot.context.properties.source.ConfigurationProperty;
import org.springframework.boot.context.properties.source.ConfigurationPropertyName;
import org.springframework.boot.context.properties.source.ConfigurationPropertySource;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.context.properties.source.ConfigurationPropertyState;
import org.springframework.core.env.Environment;

/**
 * Detects properties the typed binding ignores, e.g. an offer-level {@code network}: the binder
 * drops unknown fields, so forbidden places are checked against the raw sources.
 */
public final class RawProperties {

  private RawProperties() {}

  /**
   * Presence over an environment's property sources.
   *
   * @param environment the environment
   * @return whether a property, or any property below it, is set
   */
  public static Predicate<String> presence(Environment environment) {
    return presence(ConfigurationPropertySources.get(environment));
  }

  /**
   * Presence over configuration property sources.
   *
   * @param sources the sources
   * @return whether a property, or any property below it, is set
   */
  public static Predicate<String> presence(Iterable<ConfigurationPropertySource> sources) {
    return name -> {
      ConfigurationPropertyName key = ConfigurationPropertyName.adapt(name, '.');
      for (ConfigurationPropertySource source : sources) {
        ConfigurationProperty property = source.getConfigurationProperty(key);
        if (property != null
            || source.containsDescendantOf(key) == ConfigurationPropertyState.PRESENT) {
          return true;
        }
      }
      return false;
    };
  }

  /**
   * Undoes the binder's view of YAML lists inside free-form maps: a map whose keys are exactly
   * {@code "0".."n-1"} becomes a list, recursively; other maps get string keys.
   *
   * @param value a bound value
   * @return the value with its lists restored
   */
  public static Object restoreLists(Object value) {
    if (value instanceof Map<?, ?> map) {
      boolean indexed = !map.isEmpty();
      for (int i = 0; i < map.size() && indexed; i++) {
        indexed = map.containsKey(String.valueOf(i));
      }
      if (indexed) {
        List<Object> list = new ArrayList<>();
        for (int i = 0; i < map.size(); i++) {
          list.add(restoreLists(map.get(String.valueOf(i))));
        }
        return list;
      }
      Map<String, Object> out = new LinkedHashMap<>();
      map.forEach((k, v) -> out.put(String.valueOf(k), restoreLists(v)));
      return out;
    }
    if (value instanceof List<?> list) {
      List<Object> out = new ArrayList<>();
      list.forEach(v -> out.add(restoreLists(v)));
      return out;
    }
    return value;
  }
}
