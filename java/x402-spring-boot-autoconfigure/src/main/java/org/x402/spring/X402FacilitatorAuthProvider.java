package org.x402.spring;

import org.x402.http.FacilitatorAuthProvider;

/**
 * Auth headers for one facilitator, referenced by bean name from {@code
 * x402.facilitators[].auth-ref}; it replaces that entry's static {@code headers}.
 */
@FunctionalInterface
public interface X402FacilitatorAuthProvider extends FacilitatorAuthProvider {}
