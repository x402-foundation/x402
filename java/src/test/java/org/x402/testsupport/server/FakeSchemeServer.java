package org.x402.testsupport.server;

import org.x402.AssetAmount;
import org.x402.Price;
import org.x402.SchemeNetworkServer;
import org.x402.types.PaymentRequirements;
import org.x402.types.SupportedKind;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.UnaryOperator;

/**
 * Scheme server for tests. A money price such as {@code "$0.001"} becomes six-decimal atomic units of
 * {@link #ASSET} with the Base Sepolia USDC EIP-712 domain ({@code go/mechanisms/evm/default_assets.go}); a money
 * price naming a symbol, such as {@code "1 DAI"}, has no asset and fails like a real scheme. An
 * {@link AssetAmount} passes through. Enhancement is configurable and records the supported kind it was given.
 */
public final class FakeSchemeServer implements SchemeNetworkServer {

    /** Base Sepolia USDC, copied from {@code go/mechanisms/evm/default_assets.go}. */
    public static final String ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

    private final String scheme;
    private final UnaryOperator<PaymentRequirements> enhancer;
    private final List<SupportedKind> seenKinds = new CopyOnWriteArrayList<>();

    public FakeSchemeServer(String scheme) {
        this(scheme, UnaryOperator.identity());
    }

    public FakeSchemeServer(String scheme, UnaryOperator<PaymentRequirements> enhancer) {
        this.scheme = scheme;
        this.enhancer = enhancer;
    }

    @Override
    public String scheme() {
        return scheme;
    }

    @Override
    public AssetAmount parsePrice(Price price, String network) {
        if (price instanceof AssetAmount amount) {
            return amount;
        }
        Price.Money money = (Price.Money) price;
        if (!money.symbol().isEmpty()) {
            throw new IllegalArgumentException("no " + money.symbol() + " default asset configured for network "
                    + network);
        }
        String atomic = money.amount().movePointRight(6).toBigIntegerExact().toString();
        return new AssetAmount(atomic, ASSET, Map.of("name", "USDC", "version", "2"));
    }

    @Override
    public PaymentRequirements enhancePaymentRequirements(
            PaymentRequirements requirements, SupportedKind supportedKind) {
        seenKinds.add(supportedKind);
        return enhancer.apply(requirements);
    }

    public List<SupportedKind> seenKinds() {
        return seenKinds;
    }
}
