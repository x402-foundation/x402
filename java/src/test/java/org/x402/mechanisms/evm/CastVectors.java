package org.x402.mechanisms.evm;

import java.math.BigInteger;

/**
 * Test vectors produced independently with foundry {@code cast} 1.9.0. Each constant names the command that
 * produced it. Where a value also exists onchain, it was cross-checked with {@code cast call}.
 */
public final class CastVectors {

    /** Anvil's first default account key. */
    public static final String ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    /** {@code cast wallet address --private-key $ANVIL_KEY_0}. */
    public static final String ANVIL_ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

    /** {@code cast wallet public-key --raw-private-key $ANVIL_KEY_0}: raw {@code X || Y}. */
    public static final String ANVIL_PUBLIC_KEY_0 = "0x8318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed75"
            + "3547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5";

    /** Anvil's second default account key. */
    public static final String ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

    /** {@code cast wallet address --private-key $ANVIL_KEY_1}. */
    public static final String ANVIL_ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    /** {@code cast keccak 'TransferWithAuthorization(address from,...,bytes32 nonce)'}. */
    public static final String TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
            "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";

    /** {@code cast keccak 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'}. */
    public static final String EIP712_DOMAIN_TYPEHASH =
            "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";

    // TransferWithAuthorization of 1000 atomic Base Sepolia USDC from anvil #0 to anvil #1, signed by anvil #0.

    /** Base Sepolia USDC address. */
    public static final String BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

    /** Chain id of Base Sepolia. */
    public static final BigInteger BASE_SEPOLIA_CHAIN_ID = BigInteger.valueOf(84532);

    /** {@code cast keccak 'x402 java test nonce'}. */
    public static final String NONCE = "0x3d223d79e8d61295c1f38daf7fc45561c33722dce31231e40a83273d49b28e31";

    /** {@code validBefore} of the Base Sepolia vector. */
    public static final String VALID_BEFORE = "1740672154";

    /**
     * {@code cast keccak $(cast abi-encode 'f(bytes32,bytes32,bytes32,uint256,address)' $EIP712_DOMAIN_TYPEHASH
     * $(cast keccak USDC) $(cast keccak 2) 84532 $BASE_SEPOLIA_USDC)}; equal to {@code cast call
     * $BASE_SEPOLIA_USDC 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url https://sepolia.base.org}.
     */
    public static final String BASE_SEPOLIA_DOMAIN_SEPARATOR =
            "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818";

    /**
     * {@code cast keccak $(cast abi-encode 'f(bytes32,address,address,uint256,uint256,uint256,bytes32)'
     * $TRANSFER_WITH_AUTHORIZATION_TYPEHASH $ANVIL_ADDRESS_0 $ANVIL_ADDRESS_1 1000 0 1740672154 $NONCE)}.
     */
    public static final String BASE_SEPOLIA_STRUCT_HASH =
            "0xdbcdf43694f965b4eb48ee9e50eb1990f196793110f4554b8b2fb5da7d88572a";

    /** {@code cast keccak $(cast concat-hex 0x1901 $BASE_SEPOLIA_DOMAIN_SEPARATOR $BASE_SEPOLIA_STRUCT_HASH)}. */
    public static final String BASE_SEPOLIA_DIGEST =
            "0x5479a589c57ab8066486c3335cf7967e1931ecb7e2db71a61000fe903ae59bfe";

    /**
     * {@code cast wallet sign --data --from-file twa_base_sepolia.json --private-key $ANVIL_KEY_0}; identical to
     * {@code cast wallet sign --no-hash $BASE_SEPOLIA_DIGEST --private-key $ANVIL_KEY_0}.
     */
    public static final String BASE_SEPOLIA_SIGNATURE =
            "0x54b9f3b045b94aec7644428bf6cc9b5fe3217c0182b56eb2a2022563ef950f48"
            + "648ba7bfc320ad10aa747350221bb9ebb4f6c928eb68e54df2530555794c41a21c";

    // TransferWithAuthorization on Base ("USD Coin") with the maximum uint256 value and an all-ones nonce, from
    // anvil #1 to anvil #0, valid between 1700000000 and 1800000000, signed by anvil #1.

    /** Base USDC address. */
    public static final String BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

    /** All-ones {@code bytes32} nonce. */
    public static final String MAX_NONCE = "0x" + "ff".repeat(32);

    /** {@code cast keccak $(cast concat-hex 0x1901 $domainSeparator $structHash)} for the Base vector. */
    public static final String BASE_MAX_DIGEST = "0xa8aba3fd501cf46ad13bc021563e4b57f66656a3f3e00c39534ac157f07ae781";

    /** {@code cast wallet sign --data --from-file twa_base_max.json --private-key $ANVIL_KEY_1}. */
    public static final String BASE_MAX_SIGNATURE = "0xb870a4c5baf609142c2f6927c6a926a2fd82902cab16122f4128f74776ad0011"
            + "4287b24cee5da7ebcb34621a7786d6e2c0de88396705bdedfe69484fde0df5c81c";

    // A digest whose raw RFC 6979 signature by anvil #0 has s > n/2, so normalization must flip it.

    /** {@code cast keccak 'x402 low-s 2'}. */
    public static final String HIGH_S_DIGEST = "0xd690b326daee10db5c4cd848bce180a8ee8ee4d80060726e95f6275c72d95e70";

    /** {@code cast wallet sign --no-hash $HIGH_S_DIGEST --private-key $ANVIL_KEY_0}. */
    public static final String HIGH_S_DIGEST_SIGNATURE =
            "0x2f87bc2355c3bfd07132622a79f841d6da65b8b8549663ebd2e750ca7d82ba27"
            + "682ab26e14bc99cd8ae4c3ae4d540830e9ef0818aceb7e8186802b7e3d02b6621c";

    // Permit2's version-less domain on Base Sepolia.

    /** Canonical Permit2 address. */
    public static final String PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

    /**
     * {@code cast call $PERMIT2 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url https://sepolia.base.org}; equal to the
     * {@code cast abi-encode} + {@code cast keccak} derivation with {@code EIP712Domain(string name,uint256
     * chainId,address verifyingContract)}.
     */
    public static final String PERMIT2_BASE_SEPOLIA_DOMAIN_SEPARATOR =
            "0x010f27a92fb9a32622f44f001dc4d15706a85b33499cfc2ce9033113ab26592c";

    // Note(address author,bool approved,uint8 priority,string text,bytes4 tag,uint64 amount) under the domain
    // {name: "x402 Java", chainId: 1}: covers every supported field type.

    /** {@code cast keccak 'Note(address author,bool approved,uint8 priority,string text,bytes4 tag,uint64 amount)'}. */
    public static final String NOTE_TYPEHASH = "0x69c118e70e54f45a5bb382099365e3a97694ff153cae8e20012ec060f0c260fb";

    /** {@code hashStruct} of the note, from {@code cast abi-encode} + {@code cast keccak}. */
    public static final String NOTE_STRUCT_HASH = "0x08434402bbc6e759aafa0c8304fee2da2e3188a047303bc501e647b77819b3eb";

    /** Digest of the note, from {@code cast keccak $(cast concat-hex 0x1901 ...)}. */
    public static final String NOTE_DIGEST = "0x4792b91b2cd8ffd0fa14bc9d3f7f07672c4b2bdfcacdb0a031f8c730f3481faa";

    /** {@code cast wallet sign --data --from-file all_types.json --private-key $ANVIL_KEY_0}. */
    public static final String NOTE_SIGNATURE = "0xbdcbe9f0c797f80c45da27c0d32a3619664e1e1ec686ea3e70af4f7638711400"
            + "492a0673555dd4b9f288a3ca7e516d4af0bde2698d320eb68314eb2e575d827d1c";

    private CastVectors() {
    }
}
