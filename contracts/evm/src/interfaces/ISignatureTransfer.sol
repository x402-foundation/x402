// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISignatureTransfer
 * @notice Interface for Permit2's SignatureTransfer functionality
 * @dev Based on Uniswap's canonical Permit2 contract
 */
interface ISignatureTransfer {
    /**
     * @notice The token and amount details for a transfer signed in the permit transfer signature
     */
    struct TokenPermissions {
        // ERC20 token address
        address token;
        // the maximum amount that can be spent
        uint256 amount;
    }

    /**
     * @notice The signed permit message for a single token transfer
     */
    struct PermitTransferFrom {
        TokenPermissions permitted;
        // a unique value for every token owner's signature to prevent signature replays
        uint256 nonce;
        // deadline on the permit signature
        uint256 deadline;
    }

    /**
     * @notice Specifies the recipient address and amount for batched transfers.
     * @dev Recipients and amounts correspond to the index of the signed token permissions array.
     * @dev Reverts if the requested amount is greater than the permitted signed amount.
     */
    struct SignatureTransferDetails {
        // recipient address
        address to;
        // spender requested amount
        uint256 requestedAmount;
    }

    /**
     * @notice A map from token owner address and a caller specified word
     *         index to a bitmap. Used to set bits in the bitmap to prevent
     *         against signature replay protection
     * @dev Uses unordered nonces so that permit messages do not need to be
     *      spent in a certain order
     * @dev The mapping is indexed first by the token owner, then by an
     *      index specified in the nonce
     * @dev It returns a uint256 bitmap
     * @dev The index, or wordPosition is capped at type(uint248).max
     */
    function nonceBitmap(address, uint256) external view returns (uint256);

    /**
     * @notice Transfers a token using a signed permit message
     * @dev Reverts if the requested amount is greater than the permitted signed amount
     * @param permit The permit data signed over by the owner
     * @param owner The owner of the tokens to transfer
     * @param transferDetails The spender's requested transfer details for the permitted token
     * @param signature The signature to verify
     */
    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    /**
     * @notice Transfers a token using a signed permit message
     * @notice Includes extra data provided by the caller to verify
     *         signature over
     * @dev The witness type string must follow EIP712 ordering of nested
     *      structs and must include the TokenPermissions type definition
     * @dev Reverts if the requested amount is greater than the permitted
     *      signed amount
     * @param permit The permit data signed over by the owner
     * @param transferDetails The spender's requested transfer details for
     *        the permitted token
     * @param owner The owner of the tokens to transfer
     * @param witness Extra data to include when checking the user signature
     * @param witnessTypeString The EIP-712 type definition for remaining
     *        string stub of the typehash
     * @param signature The signature to verify
     */
    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}
