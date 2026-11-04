package org.x402.mechanisms.evm;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * The default USD-pegged asset of each EVM network, copied from Go's {@code mechanisms/evm/default_assets.go} in
 * the same order.
 *
 * <p>The first asset listed for a network is its default: a price of {@code "$0.01"} on {@code eip155:8453} is
 * paid in Base USDC. A network may list further assets that a money price selects by symbol, e.g.
 * {@code "0.01 USDT"} on Celo ({@code eip155:42220}). Some networks' defaults use Permit2 instead of EIP-3009
 * (see {@link DefaultAsset#isEip3009()}); this SDK cannot pay or settle those.
 *
 * <p>Networks are matched exactly; symbols and token addresses are matched case-insensitively. The table is
 * immutable and this class is thread-safe.
 */
public final class DefaultAssets {

    private static final String EIP3009 = "";

    private static final Map<String, List<DefaultAsset>> ASSETS = table(
            // Base
            network("eip155:8453",
                    eip3009("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2", 6, "USDC")),
            // Base Sepolia
            network("eip155:84532",
                    eip3009("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", "2", 6, "USDC")),
            // Ethereum
            network("eip155:1",
                    eip3009("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USD Coin", "2", 6, "USDC")),
            // Avalanche C-Chain
            network("eip155:43114",
                    eip3009("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "USD Coin", "2", 6, "USDC")),
            // MegaETH
            network("eip155:4326",
                    permit2("0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7", "MegaUSD", "1", 18, "MegaUSD", true)),
            // Monad
            network("eip155:143",
                    eip3009("0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "USDC", "2", 6, "USDC")),
            // Monad testnet
            network("eip155:10143",
                    eip3009("0x534b2f3A21130d7a60830c2Df862319e593943A3", "USDC", "2", 6, "USDC")),
            // Stable
            network("eip155:988",
                    eip3009("0x779Ded0c9e1022225f8E0630b35a9b54bE713736", "USDT0", "1", 6, "USDT0")),
            // Stable testnet
            network("eip155:2201",
                    eip3009("0x78Cf24370174180738C5B8E352B6D14c83a6c9A9", "USDT0", "1", 6, "USDT0")),
            // Polygon
            network("eip155:137",
                    eip3009("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USD Coin", "2", 6, "USDC")),
            // Arbitrum One
            network("eip155:42161",
                    eip3009("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USD Coin", "2", 6, "USDC")),
            // Arbitrum Sepolia
            network("eip155:421614",
                    eip3009("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", "USD Coin", "2", 6, "USDC")),
            // Mezo
            network("eip155:31612",
                    permit2("0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186", "Mezo USD", "1", 18, "mUSD", true)),
            // Mezo testnet
            network("eip155:31611",
                    permit2("0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503", "Mezo USD", "1", 18, "mUSD", true)),
            // Radius
            network("eip155:723487",
                    permit2("0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb", "Stable Coin", "1", 6, "SBC", true)),
            // Radius testnet
            network("eip155:72344",
                    permit2("0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb", "Stable Coin", "1", 6, "SBC", true)),
            // ADI
            network("eip155:36900",
                    eip3009("0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2", "USDC.e", "2", 6, "USDC.e")),
            // HPP
            network("eip155:190415",
                    eip3009("0x401eCb1D350407f13ba348573E5630B83638E30D", "Bridged USDC", "2", 6, "USDC.e")),
            // HPP Sepolia
            network("eip155:181228",
                    eip3009("0x401eCb1D350407f13ba348573E5630B83638E30D", "Bridged USDC", "2", 6, "USDC.e")),
            // XDC
            network("eip155:50",
                    eip3009("0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1", "USDC", "2", 6, "USDC")),
            // XDC Apothem
            network("eip155:51",
                    eip3009("0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4", "USDC", "2", 6, "USDC")),
            // Igra
            network("eip155:38833",
                    permit2("0xA5b8BF902b2844dA17d4506cc827F7F1681735E7", "USDC", "1", 6, "USDC", false)),
            // Flare
            network("eip155:14",
                    eip3009("0xe7cd86e13AC4309349F30B3435a9d337750fC82D", "USD₮0", "1", 6, "USDT0")),
            // Celo
            network("eip155:42220",
                    eip3009("0xcebA9300f2b948710d2653dD7B07f33A8B32118C", "USDC", "2", 6, "USDC"),
                    eip3009("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", "Tether USD", "1", 6, "USDT"),
                    eip3009("0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", "Tether America USD", "1", 6, "USAT")),
            // Celo Sepolia
            network("eip155:11142220",
                    eip3009("0x01C5C0122039549AD1493B8220cABEdD739BC44E", "USDC", "2", 6, "USDC")),
            // Sei
            network("eip155:1329",
                    eip3009("0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", "USDC", "2", 6, "USDC")),
            // Sei testnet
            network("eip155:1328",
                    eip3009("0x4fCF1784B31630811181f670Aea7A7bEF803eaED", "USDC", "2", 6, "USDC")),
            // Arc
            network("eip155:5042",
                    eip3009("0x3600000000000000000000000000000000000000", "USDC", "2", 6, "USDC")),
            // Arc testnet
            network("eip155:5042002",
                    eip3009("0x3600000000000000000000000000000000000000", "USDC", "2", 6, "USDC")),
            // World Chain
            network("eip155:480",
                    eip3009("0x79A02482A880bCE3F13e09Da970dC34db4CD24d1", "USDC", "2", 6, "USDC")),
            // World Chain Sepolia
            network("eip155:4801",
                    eip3009("0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88", "USDC", "2", 6, "USDC")));

    private DefaultAssets() {
    }

    /**
     * Returns the default asset of a network, the one a money price without a symbol is paid in.
     *
     * @param network the CAIP-2 network, e.g. {@code "eip155:84532"}
     * @return the first asset listed for the network, or empty if the network has none
     */
    public static Optional<DefaultAsset> defaultAsset(String network) {
        return defaultAsset(network, "");
    }

    /**
     * Returns the asset of a network that a money price with a symbol refers to, e.g. {@code "USDT"} for
     * {@code "0.01 USDT"}.
     *
     * @param network the CAIP-2 network
     * @param symbol the ticker, matched case-insensitively; empty selects the network's default asset
     * @return the matching asset, or empty if the network has none with that symbol
     */
    public static Optional<DefaultAsset> defaultAsset(String network, String symbol) {
        Objects.requireNonNull(symbol, "symbol");
        List<DefaultAsset> assets = forNetwork(network);
        if (assets.isEmpty() || symbol.isEmpty()) {
            return assets.stream().findFirst();
        }
        return assets.stream()
                .filter(asset -> asset.symbol().toUpperCase(Locale.ROOT).equals(symbol.toUpperCase(Locale.ROOT)))
                .findFirst();
    }

    /**
     * Finds a default asset by token address, e.g. to learn the decimals of the asset in a payment requirement.
     *
     * @param asset the token address, matched case-insensitively
     * @param network the CAIP-2 network
     * @return the matching asset, or empty if {@code asset} is not a default asset of the network
     */
    public static Optional<DefaultAsset> find(String asset, String network) {
        Objects.requireNonNull(asset, "asset");
        return forNetwork(network).stream()
                .filter(candidate -> candidate.address().equalsIgnoreCase(asset))
                .findFirst();
    }

    /**
     * Returns the whole table, keyed by CAIP-2 network in source order.
     *
     * @return an unmodifiable map from network to its assets, default first
     */
    public static Map<String, List<DefaultAsset>> all() {
        return ASSETS;
    }

    private static List<DefaultAsset> forNetwork(String network) {
        return ASSETS.getOrDefault(Objects.requireNonNull(network, "network"), List.of());
    }

    @SafeVarargs
    private static Map<String, List<DefaultAsset>> table(Map.Entry<String, List<DefaultAsset>>... networks) {
        Map<String, List<DefaultAsset>> table = new LinkedHashMap<>();
        for (Map.Entry<String, List<DefaultAsset>> entry : networks) {
            table.put(entry.getKey(), entry.getValue());
        }
        return Collections.unmodifiableMap(table);
    }

    private static Map.Entry<String, List<DefaultAsset>> network(String network, DefaultAsset... assets) {
        return Map.entry(network, List.of(assets));
    }

    private static DefaultAsset eip3009(String address, String name, String version, int decimals, String symbol) {
        return new DefaultAsset(address, name, version, decimals, symbol, EIP3009, false);
    }

    private static DefaultAsset permit2(
            String address, String name, String version, int decimals, String symbol, boolean supportsEip2612) {
        return new DefaultAsset(
                address, name, version, decimals, symbol, EvmConstants.ASSET_TRANSFER_METHOD_PERMIT2, supportsEip2612);
    }
}
