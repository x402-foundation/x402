package org.x402.mechanisms.evm.rpc;

/**
 * Transaction and calldata vectors produced offline with foundry {@code cast} 1.9.0. Each constant names the command
 * that produced it; {@code $TWA_SIGNATURE} is {@code CastVectors.BASE_SEPOLIA_SIGNATURE}, i.e. {@code v = 28},
 * {@code r = 0x54b9...0f48}, {@code s = 0x648b...41a2}.
 */
public final class RpcCastVectors {

    /** Canonical signature of the EIP-3009 transfer function the facilitator calls. */
    public static final String TWA_SIGNATURE =
            "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";

    /** {@code cast sig $TWA_SIGNATURE}. */
    public static final String TWA_SELECTOR = "0xe3ee160e";

    /**
     * {@code cast calldata $TWA_SIGNATURE $ANVIL_ADDRESS_0 $ANVIL_ADDRESS_1 1000 0 1740672154 $NONCE 28 $R $S}: the
     * settlement of {@code CastVectors}' Base Sepolia authorization.
     */
    public static final String TWA_CALLDATA = "0xe3ee160e"
            + "000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
            + "00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8"
            + "00000000000000000000000000000000000000000000000000000000000003e8"
            + "0000000000000000000000000000000000000000000000000000000000000000"
            + "0000000000000000000000000000000000000000000000000000000067c08c9a"
            + "3d223d79e8d61295c1f38daf7fc45561c33722dce31231e40a83273d49b28e31"
            + "000000000000000000000000000000000000000000000000000000000000001c"
            + "54b9f3b045b94aec7644428bf6cc9b5fe3217c0182b56eb2a2022563ef950f48"
            + "648ba7bfc320ad10aa747350221bb9ebb4f6c928eb68e54df2530555794c41a2";

    /** {@code cast calldata 'authorizationState(address,bytes32)' $ANVIL_ADDRESS_0 $NONCE}. */
    public static final String AUTHORIZATION_STATE_CALLDATA = "0xe94a0102"
            + "000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
            + "3d223d79e8d61295c1f38daf7fc45561c33722dce31231e40a83273d49b28e31";

    /** {@code cast calldata 'balanceOf(address)' $ANVIL_ADDRESS_0}. */
    public static final String BALANCE_OF_CALLDATA =
            "0x70a08231000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266";

    /** {@code cast keccak 'Transfer(address,address,uint256)'}. */
    public static final String TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    /** {@code cast abi-encode 'f(string)' 'USD Coin'}. */
    public static final String USD_COIN_STRING = "0x"
            + "0000000000000000000000000000000000000000000000000000000000000020"
            + "0000000000000000000000000000000000000000000000000000000000000008"
            + "55534420436f696e000000000000000000000000000000000000000000000000";

    /** {@code cast abi-encode 'f(string)' 'USD₮0'}: a multi-byte UTF-8 name, as Flare's USDT0. */
    public static final String USDT0_STRING = "0x"
            + "0000000000000000000000000000000000000000000000000000000000000020"
            + "0000000000000000000000000000000000000000000000000000000000000007"
            + "555344e282ae3000000000000000000000000000000000000000000000000000";

    /** {@code cast calldata 'Error(string)' 'FiatTokenV2: invalid signature'}. */
    public static final String INVALID_SIGNATURE_REVERT = "0x08c379a0"
            + "0000000000000000000000000000000000000000000000000000000000000020"
            + "000000000000000000000000000000000000000000000000000000000000001e"
            + "46696174546f6b656e56323a20696e76616c6964207369676e61747572650000";

    /**
     * {@code cast mktx --private-key $ANVIL_KEY_0 --nonce 7 --gas-limit 96000 --priority-gas-price 1000000000
     * --gas-price 2000000100 --chain 84532 $BASE_SEPOLIA_USDC $TWA_CALLDATA}. The gas limit is an estimate of 80000
     * plus 20%, and the fee cap is twice a base fee of 500000050 plus the tip.
     */
    public static final String SETTLEMENT_TX = "0x02f9019483014a3407843b9aca0084773594648301770094"
            + "036cbd53842c5426634e7929541ec2318f3dcf7e80b90124" + TWA_CALLDATA.substring(2)
            + "c080a07f2319cb5e5f8d58cc5300be952d0acf075ecde47c348e05d8084c237a1f5414"
            + "a059cc308b536fbbb9af9b4835191c69b4137d2119d8f4e99a696b7987bcee140e";

    /** {@code cast keccak $SETTLEMENT_TX}, equal to the {@code hash} printed by {@code cast decode-tx}. */
    public static final String SETTLEMENT_TX_HASH =
            "0x71a855f8281467be529e26b98d3d0da8b4742723ad5a91a9a9dc7763f7c8a088";

    /**
     * {@code cast mktx --private-key $ANVIL_KEY_1 --nonce 0 --gas-limit 21000 --priority-gas-price 0 --gas-price 1
     * --chain 1 $ANVIL_ADDRESS_0}: zero nonce, tip and value, empty calldata, and an {@code r} below 2^252.
     */
    public static final String MINIMAL_TX = "0x02f8620180800182520894f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
            + "8080c080a00f0ca57fd98b50746413b00ae6c41c59bdac808c4c02bcf8c09446d44084f808"
            + "a016d60e40601a64e3463a40161c0908b44f7d64c11d4e1fa0725b6c1c6378db90";

    private RpcCastVectors() {
    }
}
