package org.x402.model;

/**
 * Payload structure for the "exact" EVM payment scheme.
 * Matches the TypeScript ExactEvmPayload and Go ExactEvmPayload structures.
 */
public class ExactSchemePayload {
    /** The cryptographic signature for the payment. */
    public String signature;
    
    /** Authorization information including ERC-3009 transfer authorization. */
    public Authorization authorization;
    
    /** Default constructor for Jackson. */
    public ExactSchemePayload() {}
}
