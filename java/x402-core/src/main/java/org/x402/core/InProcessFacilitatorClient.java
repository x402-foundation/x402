package org.x402.core;

/**
 * Marks a {@link FacilitatorClient} that calls a facilitator in the same process (e.g. {@code
 * LocalFacilitatorClient}). Only such a client may use the reserved identifier {@code
 * local}; a remote client named {@code local} is rejected by the resource
 * server's builder.
 */
public interface InProcessFacilitatorClient extends FacilitatorClient {}
