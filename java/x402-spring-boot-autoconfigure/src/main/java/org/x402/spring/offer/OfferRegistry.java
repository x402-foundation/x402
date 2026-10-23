package org.x402.spring.offer;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.web.method.HandlerMethod;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.server.PaymentFlows;
import org.x402.core.server.X402ResourceServer;
import org.x402.http.PaymentOption;
import org.x402.http.RoutePattern;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.annotation.X402Payment;

/**
 * Maps handler methods to offers (stack-neutral). Offers attach to the {@link HandlerMethod} Spring
 * dispatches to, so matching cannot drift from routing. Built once at startup; every
 * offer or annotation problem is detected here.
 */
public final class OfferRegistry {

  /**
   * Request/exchange attribute naming the offer the x402 filter decided for this request. The
   * dispatch guard refuses to run an offer's handler without it.
   */
  public static final String DECIDED_OFFER = OfferRegistry.class.getName() + ".DECIDED_OFFER";

  private static final Log LOG = LogFactory.getLog(OfferRegistry.class);
  private static final Pattern CATCH_ALL = Pattern.compile("\\{\\*[^}]*}");
  private static final Pattern VARIABLE = Pattern.compile("\\{[^}]*}");

  private final Map<HandlerKey, String> byHandler = new HashMap<>();
  private final Set<String> annotatedOffers = new LinkedHashSet<>();
  private final List<String> warnings = new ArrayList<>();
  private final boolean hasOffers;

  /**
   * Builds the registry.
   *
   * @param source the stack's handler methods
   * @param offers the resolved offers
   * @param authorizationFlow whether an offer settles after the handler (then streaming handlers
   *     are refused)
   * @throws X402ConfigurationException for an unknown offer, a {@code {}} path or a streaming
   *     handler on a settle-after-handler offer
   */
  public OfferRegistry(HandlerMethodSource source, X402Offers offers,
      Predicate<String> authorizationFlow) {
    this.hasOffers = !offers.isEmpty();
    List<HandlerMethodSource.Mapping> mappings = source.mappings();
    for (HandlerMethodSource.Mapping mapping : mappings) {
      HandlerMethod handler = mapping.handlerMethod();
      String offer = annotatedOffer(handler);
      if (offer == null) {
        continue;
      }
      if (offers.offer(offer) == null) {
        throw new X402ConfigurationException("@X402Payment(\"" + offer + "\") on "
            + describe(handler) + " names no offer under x402.routes; known offers: "
            + offers.names());
      }
      if (source.isStreaming(handler) && authorizationFlow.test(offer)) {
        throw new X402ConfigurationException(describe(handler) + " is a streaming handler "
            + "protected by offer \"" + offer + "\", which settles after the handler; a stream "
            + "cannot be buffered until settlement. Return a non-streaming type, or use an "
            + "upfront payment flow");
      }
      byHandler.put(HandlerKey.of(handler), offer);
      annotatedOffers.add(offer);
    }
    offers.offers().values().forEach(o -> checkPath(o, mappings, source, authorizationFlow));
    warnings.forEach(LOG::warn);
  }

  /**
   * Whether an offer has an option whose flow settles after the handler (its response must be
   * buffered, so streaming handlers are refused).
   *
   * @param offers the offers
   * @param server the server with its registered schemes
   * @return the predicate
   */
  public static Predicate<String> settlesAfterHandler(X402Offers offers,
      X402ResourceServer server) {
    return name -> {
      if (offers.offer(name) == null) {
        return true;
      }
      for (PaymentOption option : offers.offer(name).route().accepts()) {
        SchemeNetworkServer scheme = server.getRegisteredScheme(option.network(),
            option.scheme());
        if (scheme == null) {
          return true;
        }
        try {
          if (PaymentFlows.resolve(scheme, option.extra() == null ? Map.of() : option.extra())
              .flow().settleAfterHandler()) {
            return true;
          }
        } catch (RuntimeException e) {
          return true;
        }
      }
      return false;
    };
  }

  /**
   * Whether any offer is configured; without one no request is paid and the filters do nothing.
   *
   * @return {@code true} when at least one offer exists
   */
  public boolean hasOffers() {
    return hasOffers;
  }

  private void checkPath(ResolvedOffer offer, List<HandlerMethodSource.Mapping> mappings,
      HandlerMethodSource source, Predicate<String> authorizationFlow) {
    String path = offer.path();
    if (path == null || path.isBlank()) {
      if (!annotatedOffers.contains(offer.name())) {
        warnings.add("x402: offer \"" + offer.name() + "\" has neither a path nor an "
            + "@X402Payment handler; it protects nothing");
      }
      return;
    }
    if (path.contains("{") || path.contains("}")) {
      throw new X402ConfigurationException("offer \"" + offer.name() + "\": path \"" + path
          + "\" uses {…}; x402 route patterns use :param, [param] or *");
    }
    RoutePattern pattern = RoutePattern.parse(path.strip());
    boolean matched = false;
    Set<String> overlaps = new LinkedHashSet<>();
    for (HandlerMethodSource.Mapping mapping : mappings) {
      if (!matches(pattern, mapping)) {
        continue;
      }
      matched = true;
      String annotated = byHandler.get(HandlerKey.of(mapping.handlerMethod()));
      if (annotated != null) {
        overlaps.add(annotated);
      } else if (source.isStreaming(mapping.handlerMethod())
          && authorizationFlow.test(offer.name())) {
        throw new X402ConfigurationException(describe(mapping.handlerMethod()) + " is a streaming "
            + "handler matched by offer \"" + offer.name() + "\" (path \"" + path + "\"), which "
            + "settles after the handler; a stream cannot be buffered until settlement");
      }
    }
    if (!matched) {
      warnings.add("x402: offer \"" + offer.name() + "\" path \"" + path
          + "\" matches no registered handler");
    }
    for (String annotated : overlaps) {
      warnings.add("x402: offer \"" + offer.name() + "\" path \"" + path + "\" overlaps handlers "
          + "annotated with @X402Payment(\"" + annotated + "\"); the annotation wins there");
    }
  }

  private static boolean matches(RoutePattern pattern, HandlerMethodSource.Mapping mapping) {
    for (String springPattern : mapping.patterns()) {
      String sample = RoutePattern.normalizePath(sample(springPattern));
      if (mapping.methods().isEmpty()) {
        if (pattern.matchesNormalized(sample)) {
          return true;
        }
        continue;
      }
      for (String method : mapping.methods()) {
        if (pattern.matches(method, sample)) {
          return true;
        }
      }
    }
    return false;
  }

  /** A concrete path a Spring pattern matches, e.g. {@code /report/{id}} → {@code /report/x}. */
  static String sample(String springPattern) {
    String s = CATCH_ALL.matcher(springPattern).replaceAll("x/y");
    s = VARIABLE.matcher(s).replaceAll("x");
    return s.replace("**", "x/y").replace("*", "x").replace("?", "x");
  }

  /**
   * A handler is its bean type and its method: an inherited method served by two controllers is
   * two handlers.
   */
  private record HandlerKey(Class<?> beanType, Method method) {
    static HandlerKey of(HandlerMethod handler) {
      return new HandlerKey(handler.getBeanType(), handler.getMethod());
    }
  }

  private static String annotatedOffer(HandlerMethod handler) {
    X402Payment onMethod =
        AnnotatedElementUtils.findMergedAnnotation(handler.getMethod(), X402Payment.class);
    if (onMethod != null) {
      return onMethod.value();
    }
    X402Payment onType =
        AnnotatedElementUtils.findMergedAnnotation(handler.getBeanType(), X402Payment.class);
    return onType == null ? null : onType.value();
  }

  private static String describe(HandlerMethod handler) {
    return handler.getBeanType().getName() + "#" + handler.getMethod().getName();
  }

  /**
   * Converts a Spring mapping pattern to x402 route-pattern syntax for hooks and extensions:
   * {@code {name}} → {@code :name}, {@code {*name}} and {@code **} → {@code *}.
   *
   * @param springPattern the best-matching Spring pattern, may be {@code null}
   * @return the x402 pattern, or {@code null}
   */
  public static String toRoutePattern(String springPattern) {
    if (springPattern == null) {
      return null;
    }
    String s = CATCH_ALL.matcher(springPattern).replaceAll("*");
    s = VARIABLE.matcher(s).replaceAll(m -> {
      String inner = m.group().substring(1, m.group().length() - 1);
      int colon = inner.indexOf(':');
      return ":" + (colon < 0 ? inner : inner.substring(0, colon));
    });
    return s.replace("**", "*");
  }

  /**
   * The offer of a handler.
   *
   * @param handler the handler Spring dispatches to
   * @return the offer name, or {@code null} when the handler is not annotated
   */
  public String offerFor(Object handler) {
    if (handler instanceof HandlerMethod method) {
      return byHandler.get(HandlerKey.of(method));
    }
    return null;
  }

  /**
   * Offers used by at least one annotated handler.
   *
   * @return the offer names
   */
  public Set<String> annotatedOffers() {
    return Collections.unmodifiableSet(annotatedOffers);
  }

  /**
   * Startup warnings (already logged).
   *
   * @return the warnings
   */
  public List<String> warnings() {
    return List.copyOf(warnings);
  }
}
