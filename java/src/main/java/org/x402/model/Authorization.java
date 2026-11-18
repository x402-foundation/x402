package org.x402.model;

/**
 * ERC-3009 authorization information within a payment payload.
 * Matches the TypeScript ExactEvmPayloadAuthorization and Go ExactEvmPayloadAuthorization structures.
 */
public class Authorization {
    /** Wallet address of the person making the payment (sender). */
    public String from;
    
    /** Wallet address receiving the payment. */
    public String to;
    
    /** Payment amount in atomic units. */
    public String value;
    
    /** Timestamp after which the authorization is valid. */
    public String validAfter;
    
    /** Timestamp before which the authorization is valid. */
    public String validBefore;
    
    /** Unique hex-encoded nonce to prevent replay attacks. */
    public String nonce;
    
    /** Default constructor for Jackson. */
    public Authorization() {}
}
