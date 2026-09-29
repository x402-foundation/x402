package org.x402.client;

/** JSON returned by POST /settle on the facilitator. */
public class SettlementResponse {
    /** Whether the payment settlement succeeded. */
    public boolean success;
    
    /** Error message if settlement failed. */
    public String  error;
    
    /** Transaction hash of the settled payment. */
    public String  txHash;
    
    /** Network ID where the settlement occurred. */
    public String  networkId;
}
