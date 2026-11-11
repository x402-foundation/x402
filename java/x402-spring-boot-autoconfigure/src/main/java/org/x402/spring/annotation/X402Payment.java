package org.x402.spring.annotation;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Protects a handler with the offer {@code x402.routes.<value>}. On a class it applies to every
 * handler method; a method-level annotation overrides it. An unknown offer name fails startup.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.TYPE})
public @interface X402Payment {

  /**
   * The offer name, a key under {@code x402.routes}.
   *
   * @return the offer name
   */
  String value();
}
