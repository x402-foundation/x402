package org.x402.mechanisms.evm.exact;

import org.x402.AssetAmount;
import org.x402.Price;
import org.x402.SchemeNetworkServer;
import org.x402.mechanisms.evm.DefaultAsset;
import org.x402.mechanisms.evm.DefaultAssets;
import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.EvmConstants;
import org.x402.mechanisms.evm.TokenAmounts;
import org.x402.mechanisms.evm.Uint256;
import org.x402.types.PaymentRequirements;
import org.x402.types.SupportedKind;

import java.math.BigInteger;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Resource-server side of the {@code exact} scheme on EVM networks: turns a route's price into the asset, atomic
 * amount and EIP-712 domain that clients sign an EIP-3009 authorization for.
 *
 * <pre>{@code
 * X402ResourceServer server = X402ResourceServer.builder()
 *         .facilitator(facilitatorClient)
 *         .register("eip155:84532", new ExactEvmServerScheme())
 *         .build();
 * }</pre>
 *
 * <p>Prices resolve as follows:
 * <ul>
 *   <li>A money price is paid in the network's {@link DefaultAssets} entry, or the entry whose symbol it names,
 *       converted at that token's decimals with extra precision truncated. {@code "$0.001"} on
 *       {@code eip155:84532} becomes 1000 atomic units of Base Sepolia USDC
 *       ({@code 0x036CbD53842c5426634e7929541eC2318f3dCF7e}) with {@code extra} {@code {"name":"USDC",
 *       "version":"2"}}; {@code "0.01 USDT"} on Celo ({@code eip155:42220}) selects Tether USD.</li>
 *   <li>An {@link AssetAmount} is used as given, so any EIP-3009 token can be priced in its own atomic units:
 *       {@code new AssetAmount("1000", tokenAddress, Map.of("name", "My Token", "version", "1"))}.</li>
 * </ul>
 *
 * <p>Only EIP-3009 tokens are supported. Networks whose default asset is transferred with Permit2 (for example
 * MegaETH, Mezo, Radius and Igra) cannot be priced in money; they need an {@link AssetAmount} of an EIP-3009
 * token.
 *
 * <p>The scheme has no state: instances are immutable and thread-safe.
 */
public final class ExactEvmServerScheme implements SchemeNetworkServer {

    /** Creates the scheme. It needs no configuration: money prices resolve through {@link DefaultAssets}. */
    public ExactEvmServerScheme() {
    }

    /**
     * Returns {@value EvmConstants#SCHEME_EXACT}.
     *
     * @return the scheme id
     */
    @Override
    public String scheme() {
        return EvmConstants.SCHEME_EXACT;
    }

    /**
     * Converts a route price into an amount of a concrete token.
     *
     * <p>An {@link AssetAmount} is returned as is; its amount and asset are checked later by
     * {@link #enhancePaymentRequirements}. A {@link Price.Money} is converted into the network's default asset, or
     * the default asset with its symbol, at that asset's decimals. Digits beyond the token's precision are
     * truncated, so {@code "$0.0000005"} is 0 atomic USDC. The result's {@code extra} holds the token's EIP-712
     * domain, {@code name} then {@code version}.
     *
     * @param price the route price
     * @param network the CAIP-2 network the price applies to, e.g. {@code "eip155:8453"}
     * @return the asset amount in atomic units
     * @throws IllegalArgumentException if an {@code AssetAmount} has an empty asset, the network has no default
     *     asset (with that symbol), that asset is not an EIP-3009 token, or the converted amount exceeds
     *     {@code uint256}
     */
    @Override
    public AssetAmount parsePrice(Price price, String network) {
        Objects.requireNonNull(price, "price");
        Objects.requireNonNull(network, "network");
        if (price instanceof AssetAmount assetAmount) {
            if (assetAmount.asset().isEmpty()) {
                throw new IllegalArgumentException(
                        ExactEvmErrors.SERVER_ASSET_ADDRESS_REQUIRED + ": the AssetAmount price has no asset address");
            }
            return assetAmount;
        }
        Price.Money money = (Price.Money) price;
        DefaultAsset asset = DefaultAssets.defaultAsset(network, money.symbol())
                .orElseThrow(() -> new IllegalArgumentException(noDefaultAsset(money.symbol(), network)));
        requireEip3009(asset, network);
        BigInteger amount = TokenAmounts.toAtomic(money.amount(), asset.decimals());
        return new AssetAmount(amount.toString(), asset.address(), domain(asset, Map.of()));
    }

    /**
     * Completes requirements built from a parsed price and the route's {@code extra}:
     * <ul>
     *   <li>an absent or empty {@code asset} becomes the network's default asset;</li>
     *   <li>a decimal {@code amount} such as {@code "0.5"} is converted to atomic units at the default asset's
     *       decimals, truncating extra precision; an integer amount is kept verbatim;</li>
     *   <li>{@code extra.name} and {@code extra.version} are set to the default asset's EIP-712 domain where they
     *       are unset, so route configuration always wins;</li>
     *   <li>every other member is returned unchanged.</li>
     * </ul>
     * For example, requirements for {@code eip155:84532} with no asset, amount {@code "1000"} and
     * {@code extra} {@code {"version":"2"}} come back with asset {@code 0x036CbD53842c5426634e7929541eC2318f3dCF7e}
     * and {@code extra} {@code {"version":"2","name":"USDC"}}.
     *
     * <p>Requirements no facilitator could verify are rejected:
     * <ul>
     *   <li>the asset must be an address, and an EIP-3009 token if it is a {@link DefaultAssets} entry;</li>
     *   <li>{@code extra.assetTransferMethod}, if set, must be {@code "eip3009"};</li>
     *   <li>any other token must carry non-empty {@code extra.name} and {@code extra.version}, because its
     *       EIP-712 domain cannot be looked up;</li>
     *   <li>a decimal amount needs a default asset's decimals, and the final amount must be a base-10
     *       {@code uint256}.</li>
     * </ul>
     *
     * @param requirements the requirements built from the parsed price; {@code network} must be set
     * @param supportedKind the matching kind advertised by the facilitator; not used by this scheme and may be
     *     {@code null}
     * @return the completed requirements
     * @throws IllegalArgumentException if the requirements break one of the rules above; the message starts with
     *     the matching {@link ExactEvmErrors} reason code where one exists
     * @throws NullPointerException if {@code requirements.network()} is {@code null}
     */
    @Override
    public PaymentRequirements enhancePaymentRequirements(
            PaymentRequirements requirements, SupportedKind supportedKind) {
        Objects.requireNonNull(requirements, "requirements");
        String network = Objects.requireNonNull(requirements.network(), "requirements.network");
        if (!ExactEvmExtra.usesEip3009(requirements.extra())) {
            throw new IllegalArgumentException("Only EIP-3009 payments are supported, but extra.assetTransferMethod is "
                    + ExactEvmExtra.assetTransferMethod(requirements.extra()));
        }
        String asset = assetOrDefault(requirements.asset(), network);
        return DefaultAssets.find(asset, network)
                .map(known -> enhanceDefaultAsset(requirements, asset, known))
                .orElseGet(() -> requireCompleteCustomAsset(requirements, asset));
    }

    private static String assetOrDefault(String asset, String network) {
        if (asset == null || asset.isEmpty()) {
            return DefaultAssets.defaultAsset(network)
                    .orElseThrow(() -> new IllegalArgumentException(
                            ExactEvmErrors.SERVER_NO_ASSET_SPECIFIED + ": " + noDefaultAsset("", network)))
                    .address();
        }
        if (!EvmAddress.isValid(asset)) {
            throw new IllegalArgumentException("requirements.asset is not an EVM address: " + asset);
        }
        return asset;
    }

    private static PaymentRequirements enhanceDefaultAsset(
            PaymentRequirements requirements, String asset, DefaultAsset known) {
        requireEip3009(known, requirements.network());
        String amount = requirements.amount();
        if (amount != null && amount.indexOf('.') >= 0) {
            amount = decimalToAtomic(amount, known.decimals());
        }
        requireAtomic(amount);
        return new PaymentRequirements(requirements.scheme(), requirements.network(), asset, amount,
                requirements.payTo(), requirements.maxTimeoutSeconds(), domain(known, requirements.extra()));
    }

    /**
     * Checks requirements for a token outside the default-asset table. Its decimals and EIP-712 domain are
     * unknown, and guessing them would produce prices off by orders of magnitude or signatures no facilitator
     * accepts.
     */
    private static PaymentRequirements requireCompleteCustomAsset(PaymentRequirements requirements, String asset) {
        String amount = requirements.amount();
        if (amount != null && amount.indexOf('.') >= 0) {
            throw new IllegalArgumentException(ExactEvmErrors.SERVER_FAILED_TO_PARSE_AMOUNT + ": cannot convert "
                    + amount + " because the decimals of " + asset + " on " + requirements.network()
                    + " are unknown; give the amount in atomic units");
        }
        requireAtomic(amount);
        if (isNullOrEmpty(ExactEvmExtra.string(requirements.extra(), ExactEvmExtra.NAME))
                || isNullOrEmpty(ExactEvmExtra.string(requirements.extra(), ExactEvmExtra.VERSION))) {
            throw new IllegalArgumentException(ExactEvmErrors.MISSING_EIP712_DOMAIN + ": " + asset
                    + " is not a default asset of " + requirements.network()
                    + "; set extra.name and extra.version to the token's EIP-712 domain");
        }
        return requirements;
    }

    private static boolean isNullOrEmpty(String value) {
        return value == null || value.isEmpty();
    }

    /**
     * Returns {@code extra} plus the asset's EIP-712 name and version where they are unset. A {@code null} value
     * counts as unset because it is dropped from the JSON sent to clients.
     */
    private static Map<String, Object> domain(DefaultAsset asset, Map<String, Object> extra) {
        Map<String, Object> completed = new LinkedHashMap<>(ExactEvmExtra.orEmpty(extra));
        completed.putIfAbsent(ExactEvmExtra.NAME, asset.name());
        completed.putIfAbsent(ExactEvmExtra.VERSION, asset.version());
        return completed;
    }

    private static String decimalToAtomic(String amount, int decimals) {
        try {
            return TokenAmounts.toAtomic(amount, decimals).toString();
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(ExactEvmErrors.SERVER_FAILED_TO_PARSE_AMOUNT + ": " + e.getMessage(), e);
        }
    }

    private static void requireAtomic(String amount) {
        try {
            Uint256.parse(Objects.requireNonNullElse(amount, ""));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(ExactEvmErrors.SERVER_FAILED_TO_PARSE_AMOUNT
                    + ": requirements.amount must be a uint256 in atomic units, got " + amount, e);
        }
    }

    private static void requireEip3009(DefaultAsset asset, String network) {
        if (!asset.isEip3009()) {
            throw new IllegalArgumentException("The " + asset.symbol() + " default asset of " + network + " ("
                    + asset.address() + ") is transferred with " + asset.assetTransferMethod()
                    + ", but this SDK only implements EIP-3009; price the route with an AssetAmount of an EIP-3009"
                    + " token instead");
        }
    }

    private static String noDefaultAsset(String symbol, String network) {
        return symbol.isEmpty()
                ? "no default asset configured for network " + network
                : "no " + symbol + " default asset configured for network " + network;
    }
}
