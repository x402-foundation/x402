package org.x402.spring.properties;

import org.springframework.core.convert.converter.Converter;
import org.x402.core.utils.Amounts;

/**
 * Binds a money string to a {@link PriceSpec}. The syntax is checked here; whether the ticker exists on a network is checked at startup by the scheme.
 */
public final class PriceSpecConverter implements Converter<String, PriceSpec> {

  @Override
  public PriceSpec convert(String source) {
    Amounts.parseMoney(source);
    return PriceSpec.money(source.strip());
  }
}
