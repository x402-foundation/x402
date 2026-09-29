package org.x402.model;

import java.util.ArrayList;
import java.util.List;

/** HTTP 402 response body returned by an x402-enabled server. */
public class PaymentRequiredResponse {
    public int x402Version;
    public List<PaymentRequirements> accepts = new ArrayList<>();
    public String error;
}
