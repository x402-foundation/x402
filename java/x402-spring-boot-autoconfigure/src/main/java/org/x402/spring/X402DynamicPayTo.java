package org.x402.spring;

import org.x402.http.DynamicPayTo;

/** A per-request receiving address, referenced by bean name from {@code pay-to-ref}. */
@FunctionalInterface
public interface X402DynamicPayTo extends DynamicPayTo {}
