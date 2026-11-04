package org.x402.model;

import org.x402.util.Json;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

/** Base header object encoded into X-PAYMENT. */
public class PaymentPayload {
    public int x402Version;
    public String scheme;
    public String network;
    public Map<String,Object> payload; // scheme‑specific map

    /** Serialise and base64‑encode for the X‑PAYMENT header. */
    public String toHeader() {
        try {
            String json = Json.MAPPER.writeValueAsString(this);
            return Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException("Unable to encode payment header", e);
        }
    }

    /** Decode from the header. */
    public static PaymentPayload fromHeader(String header) throws IOException {
        byte[] decoded = Base64.getDecoder().decode(header);
        return Json.MAPPER.readValue(decoded, PaymentPayload.class);
    }
}
