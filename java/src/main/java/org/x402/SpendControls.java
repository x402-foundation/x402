package org.x402;

import org.x402.types.PaymentRequirements;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Client-side limits that protect a payer from a server asking for an unexpected asset or amount.
 *
 * <p>An {@link X402Client} enforces spend controls during selection, before {@link PaymentPolicy} instances and the
 * {@link PaymentRequirementsSelector} run, and again in {@link X402Client#createPaymentPayload}, so the client never
 * signs a payment they reject. They are on by default with two rules:
 * <ul>
 *   <li><strong>Asset allowlist.</strong> An option is accepted only if its scheme recognizes the asset as one of
 *       its default assets ({@link SchemeNetworkClient#defaultAssetDecimals} is present) or the asset was added
 *       with {@link Builder#allowAsset(String, String)}.</li>
 *   <li><strong>USD cap.</strong> Default assets are USD stablecoins, so their amount is capped at
 *       {@value #DEFAULT_MAX_AMOUNT_PER_PAYMENT} per payment, converted to atomic units with the asset's decimals
 *       and truncated. For a 6-decimal token, {@code $1} is {@code 1000000} atomic units.</li>
 * </ul>
 *
 * <p>An asset added with {@link Builder#allowAsset(String, String, BigInteger)} carries its own cap in atomic units,
 * which replaces the USD cap for that asset. An offer that mixes affordable and unaffordable options keeps the
 * affordable ones; selection fails only when every option is rejected, with
 * {@link PaymentException#SPEND_CONTROLS_ASSET_NOT_ALLOWED} or
 * {@link PaymentException#SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED}.
 *
 * <p>Example: a 25 cent cap on default stablecoins, plus one extra 18-decimal token capped at 5 tokens on Base:
 * <pre>{@code
 * SpendControls controls = SpendControls.builder()
 *         .maxAmountPerPayment("$0.25")
 *         .allowAsset("eip155:8453", tokenAddress, new BigInteger("5000000000000000000"))
 *         .build();
 * }</pre>
 *
 * <p>Allowed assets are matched by address only, because {@link SchemeNetworkClient} does not expose asset
 * symbols.
 *
 * <p>Instances are immutable and thread-safe.
 */
public final class SpendControls {

    /** The per-payment cap, in USD, applied to default assets unless configured otherwise. */
    public static final String DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1";

    private static final Pattern MONEY = Pattern.compile("^\\d+(?:\\.\\d+)?$");
    private static final Pattern ATOMIC = Pattern.compile("^\\d+$");

    private static final SpendControls DEFAULTS = builder().build();
    private static final SpendControls DISABLED = new SpendControls(false, null, true, List.of());

    private final boolean enabled;
    private final BigDecimal maxAmountPerPayment;
    private final boolean allowAnyAsset;
    private final List<AllowedAsset> allowedAssets;

    private SpendControls(
            boolean enabled, BigDecimal maxAmountPerPayment, boolean allowAnyAsset, List<AllowedAsset> allowedAssets) {
        this.enabled = enabled;
        this.maxAmountPerPayment = maxAmountPerPayment;
        this.allowAnyAsset = allowAnyAsset;
        this.allowedAssets = List.copyOf(allowedAssets);
    }

    /**
     * Returns the default controls: default assets only, capped at {@value #DEFAULT_MAX_AMOUNT_PER_PAYMENT}.
     *
     * @return the default controls
     */
    public static SpendControls defaults() {
        return DEFAULTS;
    }

    /**
     * Returns controls that accept any asset and any amount. Use only when every server the client talks to is
     * trusted.
     *
     * @return the disabled controls
     */
    public static SpendControls disabled() {
        return DISABLED;
    }

    /**
     * Returns a builder that starts from the {@linkplain #defaults() defaults}.
     *
     * @return a new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Returns whether any control is enforced.
     *
     * @return {@code false} only for {@link #disabled()}
     */
    public boolean isEnabled() {
        return enabled;
    }

    /**
     * Returns the USD cap applied to default assets.
     *
     * @return the cap, or empty when the controls are disabled or the USD cap is turned off
     */
    public Optional<BigDecimal> maxAmountPerPayment() {
        return Optional.ofNullable(maxAmountPerPayment);
    }

    /**
     * Returns whether assets that are neither default assets nor {@linkplain #allowedAssets() allowed assets} are
     * accepted.
     *
     * @return {@code true} if any asset is accepted
     */
    public boolean allowsAnyAsset() {
        return allowAnyAsset;
    }

    /**
     * Returns the assets accepted in addition to the schemes' default assets.
     *
     * @return the allowed assets, unmodifiable
     */
    public List<AllowedAsset> allowedAssets() {
        return allowedAssets;
    }

    /**
     * Keeps the options these controls accept.
     *
     * @param candidates the options to check, with non-null {@code network}, {@code asset} and {@code amount}
     * @param defaultAssetDecimals the decimals of an option's asset when its scheme recognizes it as a default asset
     * @return the accepted options, in their original order
     * @throws PaymentException if every option is rejected
     */
    List<PaymentRequirements> filter(
            List<PaymentRequirements> candidates, Function<PaymentRequirements, OptionalInt> defaultAssetDecimals) {
        if (!enabled) {
            return candidates;
        }
        List<PaymentRequirements> allowed = new ArrayList<>();
        for (PaymentRequirements requirements : candidates) {
            if (allowAnyAsset
                    || defaultAssetDecimals.apply(requirements).isPresent()
                    || allowedAssetFor(requirements) != null) {
                allowed.add(requirements);
            }
        }
        if (allowed.isEmpty()) {
            throw new PaymentException(PaymentException.SPEND_CONTROLS_ASSET_NOT_ALLOWED,
                    "all payment requirements were rejected by spend controls: only default assets or assets added "
                            + "with SpendControls.Builder.allowAsset are accepted. Allow the asset, call "
                            + "allowAnyAsset(), or use SpendControls.disabled()");
        }

        List<PaymentRequirements> affordable = new ArrayList<>();
        String rejectedByUsdCap = null;
        for (PaymentRequirements requirements : allowed) {
            AllowedAsset entry = allowedAssetFor(requirements);
            boolean perAssetCap = entry != null && entry.maxAmountPerPayment() != null;
            BigInteger cap = perAssetCap
                    ? entry.maxAmountPerPayment()
                    : usdCapInAtomicUnits(defaultAssetDecimals.apply(requirements));
            if (cap == null || withinCap(requirements.amount(), cap, perAssetCap)) {
                affordable.add(requirements);
            } else if (!perAssetCap) {
                rejectedByUsdCap = requirements.asset();
            }
        }
        if (affordable.isEmpty()) {
            throw amountExceeded(allowed, rejectedByUsdCap);
        }
        return Collections.unmodifiableList(affordable);
    }

    private PaymentException amountExceeded(List<PaymentRequirements> allowed, String rejectedByUsdCap) {
        boolean onlyPerAssetCaps = allowed.stream().allMatch(requirements -> {
            AllowedAsset entry = allowedAssetFor(requirements);
            return entry != null && entry.maxAmountPerPayment() != null;
        });
        if (onlyPerAssetCaps) {
            return new PaymentException(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED,
                    "all payment requirements were rejected by the per-asset maxAmountPerPayment of "
                            + "SpendControls.Builder.allowAsset. Raise the per-asset cap, or omit it to allow the "
                            + "asset uncapped (default assets then fall back to the USD cap)");
        }
        return new PaymentException(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED,
                "all payment requirements were rejected by spend controls maxAmountPerPayment ($"
                        + maxAmountPerPayment.toPlainString() + ", including asset " + rejectedByUsdCap + "). "
                        + "Raise maxAmountPerPayment, call noMaxAmountPerPayment(), set a per-asset atomic cap "
                        + "with allowAsset, or use SpendControls.disabled()");
    }

    /** Returns the allowed-asset entry matching an option, or {@code null}. Ignored when any asset is allowed. */
    private AllowedAsset allowedAssetFor(PaymentRequirements requirements) {
        if (allowAnyAsset) {
            return null;
        }
        for (AllowedAsset entry : allowedAssets) {
            if (Network.matches(entry.network(), requirements.network())
                    && entry.asset().equalsIgnoreCase(requirements.asset())) {
                return entry;
            }
        }
        return null;
    }

    private BigInteger usdCapInAtomicUnits(OptionalInt decimals) {
        if (maxAmountPerPayment == null || decimals.isEmpty()) {
            return null;
        }
        if (decimals.getAsInt() < 0) {
            throw new IllegalStateException("scheme reported negative decimals: " + decimals.getAsInt());
        }
        return maxAmountPerPayment.movePointRight(decimals.getAsInt()).setScale(0, RoundingMode.DOWN).toBigInteger();
    }

    /**
     * Compares an amount with a cap. Amounts that are not atomic integers, such as XRPL issued-currency values, are
     * compared one to one with the USD cap; they never fit a per-asset cap, which is atomic.
     */
    private boolean withinCap(String amount, BigInteger cap, boolean perAssetCap) {
        if (ATOMIC.matcher(amount).matches()) {
            return new BigInteger(amount).compareTo(cap) <= 0;
        }
        return !perAssetCap
                && MONEY.matcher(amount).matches()
                && new BigDecimal(amount).compareTo(maxAmountPerPayment) <= 0;
    }

    @Override
    public String toString() {
        if (!enabled) {
            return "SpendControls[disabled]";
        }
        return "SpendControls[maxAmountPerPayment="
                + (maxAmountPerPayment == null ? "none" : "$" + maxAmountPerPayment.toPlainString())
                + ", allowAnyAsset=" + allowAnyAsset
                + ", allowedAssets=" + allowedAssets + "]";
    }

    private static BigDecimal parseUsd(String value) {
        Objects.requireNonNull(value, "maxAmountPerPayment");
        String cleaned = (value.startsWith("$") ? value.substring(1) : value).strip();
        if (!MONEY.matcher(cleaned).matches()) {
            throw new IllegalArgumentException(
                    "maxAmountPerPayment must be a non-negative decimal USD amount such as \"$0.50\": " + value);
        }
        return new BigDecimal(cleaned);
    }

    /**
     * An asset accepted in addition to the schemes' default assets.
     *
     * @param network the CAIP-2 network, e.g. {@code "eip155:8453"}, or a wildcard such as {@code "eip155:*"}
     * @param asset the asset address, compared case-insensitively
     * @param maxAmountPerPayment the per-payment cap in the asset's atomic units, or {@code null} for no cap; when
     *     set it also replaces the USD cap if the asset is a default asset
     */
    public record AllowedAsset(String network, String asset, BigInteger maxAmountPerPayment) {

        /**
         * Creates an allowed asset.
         *
         * @throws IllegalArgumentException if {@code network} is not a network or wildcard, {@code asset} is blank,
         *     or {@code maxAmountPerPayment} is negative
         */
        public AllowedAsset {
            NetworkPatterns.require(network, "network");
            Objects.requireNonNull(asset, "asset");
            if (asset.isBlank()) {
                throw new IllegalArgumentException("asset must not be blank");
            }
            if (maxAmountPerPayment != null && maxAmountPerPayment.signum() < 0) {
                throw new IllegalArgumentException("maxAmountPerPayment must not be negative: " + maxAmountPerPayment);
            }
        }
    }

    /**
     * Builds {@link SpendControls}. Starts from the defaults: default assets only, capped at
     * {@value SpendControls#DEFAULT_MAX_AMOUNT_PER_PAYMENT}.
     *
     * <p>Builders are not thread-safe.
     */
    public static final class Builder {

        private BigDecimal maxAmountPerPayment = parseUsd(DEFAULT_MAX_AMOUNT_PER_PAYMENT);
        private boolean allowAnyAsset;
        private final List<AllowedAsset> allowedAssets = new ArrayList<>();

        private Builder() {
        }

        /**
         * Sets the USD cap applied to default assets.
         *
         * @param usd a non-negative decimal amount with an optional {@code $} prefix, e.g. {@code "$0.50"} or
         *     {@code "2"}; scientific notation and currency suffixes are rejected
         * @return this builder
         * @throws IllegalArgumentException if {@code usd} is not a valid amount
         */
        public Builder maxAmountPerPayment(String usd) {
            this.maxAmountPerPayment = parseUsd(usd);
            return this;
        }

        /**
         * Sets the USD cap applied to default assets.
         *
         * @param usd a non-negative amount in USD
         * @return this builder
         * @throws IllegalArgumentException if {@code usd} is negative
         */
        public Builder maxAmountPerPayment(BigDecimal usd) {
            Objects.requireNonNull(usd, "usd");
            if (usd.signum() < 0) {
                throw new IllegalArgumentException("maxAmountPerPayment must not be negative: " + usd);
            }
            this.maxAmountPerPayment = usd;
            return this;
        }

        /**
         * Turns off the USD cap. The asset allowlist and per-asset caps still apply.
         *
         * @return this builder
         */
        public Builder noMaxAmountPerPayment() {
            this.maxAmountPerPayment = null;
            return this;
        }

        /**
         * Accepts any asset. The USD cap still applies to default assets. Cannot be combined with
         * {@link #allowAsset(String, String)}.
         *
         * @return this builder
         */
        public Builder allowAnyAsset() {
            this.allowAnyAsset = true;
            return this;
        }

        /**
         * Accepts a non-default asset without a cap. Listing a default asset this way changes nothing: the USD cap
         * still applies to it.
         *
         * @param network the CAIP-2 network or a wildcard such as {@code "eip155:*"}
         * @param asset the asset address
         * @return this builder
         * @throws IllegalArgumentException if {@code network} is invalid or {@code asset} is blank
         */
        public Builder allowAsset(String network, String asset) {
            allowedAssets.add(new AllowedAsset(network, asset, null));
            return this;
        }

        /**
         * Accepts an asset up to a cap in its atomic units. For a default asset the cap replaces the USD cap.
         *
         * @param network the CAIP-2 network or a wildcard such as {@code "eip155:*"}
         * @param asset the asset address
         * @param maxAmountPerPayment the per-payment cap in atomic units, e.g. {@code 5000000} for 5 tokens with
         *     6 decimals
         * @return this builder
         * @throws IllegalArgumentException if {@code network} is invalid, {@code asset} is blank or the cap is
         *     negative
         */
        public Builder allowAsset(String network, String asset, BigInteger maxAmountPerPayment) {
            Objects.requireNonNull(maxAmountPerPayment, "maxAmountPerPayment");
            allowedAssets.add(new AllowedAsset(network, asset, maxAmountPerPayment));
            return this;
        }

        /**
         * Builds the spend controls.
         *
         * @return the spend controls
         * @throws IllegalStateException if both {@link #allowAnyAsset()} and {@code allowAsset} were used, since
         *     allowing any asset would silently ignore the per-asset entries
         */
        public SpendControls build() {
            if (allowAnyAsset && !allowedAssets.isEmpty()) {
                throw new IllegalStateException("allowAnyAsset() cannot be combined with allowAsset(...) entries");
            }
            return new SpendControls(true, maxAmountPerPayment, allowAnyAsset, allowedAssets);
        }
    }
}
