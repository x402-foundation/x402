package org.x402.mechanisms.evm.exact;

import org.x402.PaymentException;
import org.x402.SchemeNetworkClient;
import org.x402.mechanisms.evm.ClientEvmSigner;
import org.x402.mechanisms.evm.DefaultAsset;
import org.x402.mechanisms.evm.DefaultAssets;
import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.EvmConstants;
import org.x402.mechanisms.evm.EvmNetworks;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Secp256k1;
import org.x402.mechanisms.evm.TypedDataDomain;
import org.x402.mechanisms.evm.Uint256;
import org.x402.types.PaymentRequirements;

import java.math.BigInteger;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.Map;
import java.util.Objects;
import java.util.OptionalInt;
import java.util.random.RandomGenerator;

/**
 * Client side of the {@code exact} scheme on EVM networks: pays one {@link PaymentRequirements} entry by signing
 * an EIP-3009 {@code TransferWithAuthorization} for exactly {@code requirements.amount()} atomic units of the
 * token at {@code requirements.asset()}. The facilitator later submits the authorization onchain, so the payer
 * needs no gas.
 *
 * <pre>{@code
 * ClientEvmSigner signer = PrivateKeyEvmSigner.fromHex(System.getenv("EVM_PRIVATE_KEY"));
 * X402Client client = X402Client.builder()
 *         .register(EvmNetworks.FAMILY, new ExactEvmClientScheme(signer))   // every eip155 network
 *         .build();
 * }</pre>
 *
 * <p>Each call to {@link #createPaymentPayload} signs a fresh authorization from {@link ClientEvmSigner#address()}
 * to {@code payTo}, valid from {@code 0} until the clock's Unix time plus {@code maxTimeoutSeconds}, with a random
 * 32-byte nonce. The EIP-712 domain takes its name and version from {@code extra.name} and {@code extra.version}
 * when they are strings, otherwise from the matching {@link DefaultAssets} entry, and uses the network's chain id
 * and the asset as verifying contract. The result is the map form of {@link ExactEvmPayload}, shown in the
 * package documentation.
 *
 * <p>Only EIP-3009 is implemented. Requirements whose {@code extra.assetTransferMethod} is {@code "permit2"} or
 * any other value than {@code "eip3009"} are refused rather than signed with the wrong method.
 *
 * <p>Failures are reported as {@link PaymentException}s whose {@link PaymentException#reason() reason} is one of:
 * <ul>
 *   <li>{@link #UNSUPPORTED_ASSET_TRANSFER_METHOD}: {@code extra.assetTransferMethod} is not EIP-3009;</li>
 *   <li>{@link ExactEvmErrors#FAILED_TO_GET_NETWORK_CONFIG}: the network is not {@code eip155:<chainId>};</li>
 *   <li>{@link ExactEvmErrors#CLIENT_INVALID_AMOUNT}: the amount is not a {@code uint256} integer;</li>
 *   <li>{@link ExactEvmErrors#MISSING_EIP712_DOMAIN}: {@code extra} lacks the domain name or version and the
 *       asset is not a default asset to take them from;</li>
 *   <li>{@link ExactEvmErrors#CLIENT_FAILED_TO_SIGN_AUTHORIZATION}: the asset or {@code payTo} is not an
 *       address, {@code maxTimeoutSeconds} is negative, or the signer failed or returned a signature that
 *       breaks the {@link ClientEvmSigner} contract.</li>
 * </ul>
 * Signatures never appear in exception messages.
 *
 * <p>Instances are immutable. They are thread-safe when the signer is, as {@link ClientEvmSigner} requires.
 */
public final class ExactEvmClientScheme implements SchemeNetworkClient {

    /** Reason code for requirements that select a transfer method other than EIP-3009, e.g. Permit2. */
    public static final String UNSUPPORTED_ASSET_TRANSFER_METHOD = "unsupported_asset_transfer_method";

    private static final int NONCE_LENGTH = 32;
    private static final String VALID_AFTER = "0";

    private final ClientEvmSigner signer;
    private final Clock clock;
    private final RandomGenerator nonceSource;

    /**
     * Creates a client scheme that signs with {@code signer} and reads the system UTC clock.
     *
     * @param signer the payer's account, see {@link ClientEvmSigner} for the signing contract
     */
    public ExactEvmClientScheme(ClientEvmSigner signer) {
        this(signer, Clock.systemUTC());
    }

    /**
     * Creates a client scheme with an explicit clock, e.g. a fixed clock in tests or one that corrects for a
     * skewed system time. The clock only sets {@code validBefore}.
     *
     * @param signer the payer's account, see {@link ClientEvmSigner} for the signing contract
     * @param clock the source of the current time
     */
    public ExactEvmClientScheme(ClientEvmSigner signer, Clock clock) {
        this(signer, clock, new SecureRandom());
    }

    /**
     * Creates a client scheme with an explicit nonce source, so tests can reproduce known signatures.
     *
     * @param signer the payer's account
     * @param clock the source of the current time
     * @param nonceSource the source of nonce bytes; must be cryptographically secure outside tests
     */
    ExactEvmClientScheme(ClientEvmSigner signer, Clock clock, RandomGenerator nonceSource) {
        this.signer = Objects.requireNonNull(signer, "signer");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.nonceSource = Objects.requireNonNull(nonceSource, "nonceSource");
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
     * Returns whether {@code requirements} use EIP-3009, the only asset transfer method this scheme implements.
     *
     * @param requirements an offered {@code exact} option on an EVM network
     * @return {@code false} when {@code extra.assetTransferMethod} names another method, e.g. {@code "permit2"}
     */
    @Override
    public boolean supports(PaymentRequirements requirements) {
        return ExactEvmExtra.usesEip3009(Objects.requireNonNull(requirements, "requirements").extra());
    }

    /**
     * Signs an EIP-3009 authorization that pays {@code requirements}, as described in the class documentation.
     *
     * <p>Every member of {@code requirements} comes from the resource server and is validated before anything is
     * signed. The signer is called at most once.
     *
     * @param requirements the requirements selected for payment, e.g. one entry of a {@code PAYMENT-REQUIRED}
     *     response
     * @return the unmodifiable inner payload: {@code signature} and {@code authorization}, all values strings
     * @throws PaymentException if the requirements cannot be paid with EIP-3009 or signing fails; see the class
     *     documentation for the reason codes
     */
    @Override
    public Map<String, Object> createPaymentPayload(PaymentRequirements requirements) {
        Objects.requireNonNull(requirements, "requirements");
        if (!ExactEvmExtra.usesEip3009(requirements.extra())) {
            throw new PaymentException(UNSUPPORTED_ASSET_TRANSFER_METHOD,
                    "Only EIP-3009 payments are supported, but extra.assetTransferMethod is "
                            + ExactEvmExtra.assetTransferMethod(requirements.extra()));
        }
        BigInteger chainId = chainId(requirements.network());
        String asset = requireAddress(requirements.asset(), "asset");
        String value = atomicAmount(requirements.amount());
        TypedDataDomain domain = domain(requirements, chainId, asset);
        Eip3009Authorization authorization = authorization(requirements, value);
        byte[] signature = sign(domain, authorization);
        return new ExactEvmPayload(Hex.encode(signature), authorization).toMap();
    }

    /**
     * Returns the decimals of a {@link DefaultAssets} entry, which spend controls use to convert a USD cap into
     * atomic units. Permit2 assets are included even though this scheme cannot pay them.
     *
     * @param asset the token address, matched case-insensitively; {@code null} is not a default asset
     * @param network the CAIP-2 network; {@code null} has no default assets
     * @return the decimals, or empty when the asset is not a default asset of {@code network}
     */
    @Override
    public OptionalInt defaultAssetDecimals(String asset, String network) {
        if (asset == null || network == null) {
            return OptionalInt.empty();
        }
        return DefaultAssets.find(asset, network)
                .map(found -> OptionalInt.of(found.decimals()))
                .orElse(OptionalInt.empty());
    }

    private static BigInteger chainId(String network) {
        if (network == null) {
            throw new PaymentException(ExactEvmErrors.FAILED_TO_GET_NETWORK_CONFIG, "requirements.network is missing");
        }
        try {
            return EvmNetworks.chainId(network);
        } catch (IllegalArgumentException e) {
            throw new PaymentException(ExactEvmErrors.FAILED_TO_GET_NETWORK_CONFIG, e.getMessage(), e);
        }
    }

    private static String requireAddress(String address, String member) {
        if (!EvmAddress.isValid(address)) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "requirements." + member + " is not an EVM address: " + address);
        }
        return address;
    }

    /** Parses and re-renders the amount, so {@code "01000"} becomes {@code "1000"}. */
    private static String atomicAmount(String amount) {
        try {
            return Uint256.parse(Objects.requireNonNullElse(amount, "")).toString();
        } catch (IllegalArgumentException e) {
            throw new PaymentException(ExactEvmErrors.CLIENT_INVALID_AMOUNT,
                    "requirements.amount must be a uint256 in atomic units, got " + amount, e);
        }
    }

    private static TypedDataDomain domain(PaymentRequirements requirements, BigInteger chainId, String asset) {
        String name = ExactEvmExtra.string(requirements.extra(), ExactEvmExtra.NAME);
        String version = ExactEvmExtra.string(requirements.extra(), ExactEvmExtra.VERSION);
        if (name == null || version == null) {
            DefaultAsset known = DefaultAssets.find(asset, requirements.network())
                    .orElseThrow(() -> new PaymentException(ExactEvmErrors.MISSING_EIP712_DOMAIN,
                            "requirements.extra has no EIP-712 domain name and version, and " + asset
                                    + " is not a default asset of " + requirements.network()));
            name = name == null ? known.name() : name;
            version = version == null ? known.version() : version;
        }
        return new TypedDataDomain(name, version, chainId, asset);
    }

    private Eip3009Authorization authorization(PaymentRequirements requirements, String value) {
        String payTo = requireAddress(requirements.payTo(), "payTo");
        if (requirements.maxTimeoutSeconds() < 0) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "requirements.maxTimeoutSeconds must not be negative, got " + requirements.maxTimeoutSeconds());
        }
        long validBefore = clock.instant().getEpochSecond() + requirements.maxTimeoutSeconds();
        return new Eip3009Authorization(
                signerAddress(), payTo, value, VALID_AFTER, Long.toString(validBefore), newNonce());
    }

    private String signerAddress() {
        String address;
        try {
            address = signer.address();
        } catch (RuntimeException e) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "Signer failed to return its address", e);
        }
        if (!EvmAddress.isValid(address)) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "Signer address is not an EVM address: " + address);
        }
        return address;
    }

    private String newNonce() {
        byte[] nonce = new byte[NONCE_LENGTH];
        nonceSource.nextBytes(nonce);
        return Hex.encode(nonce);
    }

    private byte[] sign(TypedDataDomain domain, Eip3009Authorization authorization) {
        byte[] signature;
        try {
            signature = signer.signTypedData(domain, EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS,
                    EvmConstants.TRANSFER_WITH_AUTHORIZATION, authorization.toMap());
        } catch (RuntimeException e) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "Signer failed to sign the EIP-3009 authorization", e);
        }
        requireSignerContract(signature);
        return signature;
    }

    /** Rejects what the facilitator would reject anyway, so a faulty signer fails here with a precise message. */
    private static void requireSignerContract(byte[] signature) {
        if (signature == null) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "Signer returned no signature");
        }
        Secp256k1.Signature parsed;
        try {
            parsed = Secp256k1.Signature.fromBytes(signature);
        } catch (IllegalArgumentException e) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "Signer returned a malformed signature: " + e.getMessage(), e);
        }
        int v = signature[Secp256k1.SIGNATURE_LENGTH - 1] & 0xff;
        if (v != parsed.v()) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "Signer returned v = " + v + "; the signature must end with v = 27 or 28");
        }
        if (!parsed.isCanonical()) {
            throw new PaymentException(ExactEvmErrors.CLIENT_FAILED_TO_SIGN_AUTHORIZATION,
                    "Signer returned a high-s signature; s must be at most n/2 (EIP-2)");
        }
    }
}
