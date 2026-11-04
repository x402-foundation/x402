package org.x402;

import org.x402.types.PaymentRequirements;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalInt;

/** A scheme client that records the requirements it pays and reports configurable default assets. */
class FakeSchemeNetworkClient implements SchemeNetworkClient {

    private final String scheme;
    private final Map<String, Integer> defaultAssetDecimals = new LinkedHashMap<>();
    private final List<PaymentRequirements> paid = new ArrayList<>();
    private String unsupportedAmount;

    FakeSchemeNetworkClient(String scheme) {
        this.scheme = scheme;
    }

    /** Declares {@code asset} a default asset with the given decimals on every network. */
    FakeSchemeNetworkClient withDefaultAsset(String asset, int decimals) {
        defaultAssetDecimals.put(asset.toLowerCase(Locale.ROOT), decimals);
        return this;
    }

    /** Makes {@link #supports} reject options for exactly {@code amount}. */
    FakeSchemeNetworkClient rejectingAmount(String amount) {
        unsupportedAmount = amount;
        return this;
    }

    List<PaymentRequirements> paid() {
        return paid;
    }

    @Override
    public String scheme() {
        return scheme;
    }

    @Override
    public Map<String, Object> createPaymentPayload(PaymentRequirements requirements) {
        paid.add(requirements);
        return Map.of("signature", "0xsigned", "authorization", Map.of("value", requirements.amount()));
    }

    @Override
    public boolean supports(PaymentRequirements requirements) {
        return !requirements.amount().equals(unsupportedAmount);
    }

    @Override
    public OptionalInt defaultAssetDecimals(String asset, String network) {
        Integer decimals = defaultAssetDecimals.get(asset.toLowerCase(Locale.ROOT));
        return decimals == null ? OptionalInt.empty() : OptionalInt.of(decimals);
    }
}
