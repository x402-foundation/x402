package org.x402.model;

import java.util.Map;

/** Defines one acceptable way to pay for a resource. */
public class PaymentRequirements {
    public String scheme;              // e.g. "exact"
    public String network;             // e.g. "base-sepolia"
    public String maxAmountRequired;   // uint256 in wei / atomic units
    public String resource;            // URL path the client is paying for
    public String description;
    public String mimeType;            // expected response MIME
    public Map<String, Object> outputSchema; // optional JSON schema
    public String payTo;               // address (EVM / Solana etc.)
    public int maxTimeoutSeconds;
    public String asset;               // token contract address / symbol
    public Map<String, Object> extra;  // scheme‑specific
}

