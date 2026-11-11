package org.x402.spring.web.servlet;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.springframework.web.servlet.HandlerExecutionChain;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.util.ServletRequestPathUtils;

/**
 * Asks Spring's own handler mappings which handler wins, as Spring Security's {@code
 * HandlerMappingIntrospector} does, on a request wrapper whose attribute changes never reach the
 * real request.
 */
final class ServletHandlerResolver {

  /**
   * The winning handler and its pattern.
   *
   * @param handler the handler, {@code null} when none matches
   * @param pattern the best-matching pattern, may be {@code null}
   */
  record Resolution(Object handler, String pattern) {}

  private final Supplier<List<HandlerMapping>> mappings;

  ServletHandlerResolver(Supplier<List<HandlerMapping>> mappings) {
    this.mappings = mappings;
  }

  Resolution resolve(HttpServletRequest request) {
    IsolatedRequest isolated = new IsolatedRequest(request);
    try {
      for (HandlerMapping mapping : mappings.get()) {
        if (mapping.usesPathPatterns()) {
          ServletRequestPathUtils.parseAndCache(isolated);
        }
        HandlerExecutionChain chain = mapping.getHandler(isolated);
        if (chain != null) {
          Object pattern = isolated.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
          return new Resolution(chain.getHandler(), pattern == null ? null : pattern.toString());
        }
      }
    } catch (Exception e) {
      // Spring answers this request itself (e.g. 405/415): no handler. A path: offer can still
      // match it in the filter; an @X402Payment offer cannot.
      return new Resolution(null, null);
    }
    return new Resolution(null, null);
  }

  /** Keeps attribute writes local; reads fall back to the real request. */
  static final class IsolatedRequest extends HttpServletRequestWrapper {
    private final Map<String, Object> attributes = new HashMap<>();
    private final Set<String> removed = new HashSet<>();

    IsolatedRequest(HttpServletRequest request) {
      super(request);
    }

    @Override
    public Object getAttribute(String name) {
      if (attributes.containsKey(name)) {
        return attributes.get(name);
      }
      return removed.contains(name) ? null : super.getAttribute(name);
    }

    @Override
    public void setAttribute(String name, Object value) {
      if (value == null) {
        removeAttribute(name);
        return;
      }
      attributes.put(name, value);
      removed.remove(name);
    }

    @Override
    public void removeAttribute(String name) {
      attributes.remove(name);
      removed.add(name);
    }

    @Override
    public Enumeration<String> getAttributeNames() {
      Set<String> names = new LinkedHashSet<>(Collections.list(super.getAttributeNames()));
      names.removeAll(removed);
      names.addAll(attributes.keySet());
      return Collections.enumeration(names);
    }
  }
}
