package org.x402.spring;

import org.x402.http.DynamicPrice;

/** A per-request price, referenced by bean name from {@code price-ref}. */
@FunctionalInterface
public interface X402DynamicPrice extends DynamicPrice {}
