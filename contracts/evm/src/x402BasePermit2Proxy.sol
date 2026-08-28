// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";

/**
 * @title x402BasePermit2Proxy
 * @notice Abstract base contract for x402 payments using Permit2
 *
 * @dev This contract provides the shared logic for x402 payment proxies.
 *      It acts as the authorized spender in Permit2 signatures and uses the
 *      "witness" pattern to cryptographically bind the payment destination,
 *      preventing facilitators from redirecting funds.
 *
 *      The Permit2 address is passed as a constructor argument and stored as
 *      an immutable. Since Permit2 is deployed via a deterministic CREATE2
 *      deployer, its canonical address (0x000000000022D473030F116dDEE9F6B43aC78BA3)
 *      is the same on all EVM chains. Using the same constructor argument on
 *      every chain keeps the initCode identical, preserving a uniform CREATE2
 *      address for these proxies across all chains.
 *
 * @author x402 Protocol
 */
abstract contract x402BasePermit2Proxy is ReentrancyGuard {
    /// @notice The Permit2 contract address (set once at construction, immutable)
    ISignatureTransfer public immutable PERMIT2;

    /// @notice Emitted when settle() completes successfully
    event Settled();

    /// @notice Emitted when settleWithPermit() completes successfully
    event SettledWithPermit();

    /// @notice Emitted when EIP-2612 permit() reverts with an Error(string) reason
    /// @param token The token whose permit() was called
    /// @param owner The token owner for whom permit was attempted
    /// @param reason The human-readable revert reason string
    event EIP2612PermitFailedWithReason(address indexed token, address indexed owner, string reason);

    /// @notice Emitted when EIP-2612 permit() reverts with a Panic(uint256) code
    /// @param token The token whose permit() was called
    /// @param owner The token owner for whom permit was attempted
    /// @param errorCode The Solidity panic code (e.g. 0x11 for overflow, 0x01 for assert)
    event EIP2612PermitFailedWithPanic(address indexed token, address indexed owner, uint256 errorCode);

    /// @notice Emitted when EIP-2612 permit() reverts with a custom error or empty data
    /// @param token The token whose permit() was called
    /// @param owner The token owner for whom permit was attempted
    /// @param data The raw revert data (custom error selector + params, or empty)
    event EIP2612PermitFailedWithData(address indexed token, address indexed owner, bytes data);

    /// @notice Thrown when Permit2 address is zero
    error InvalidPermit2Address();

    /// @notice Thrown when destination address is zero
    error InvalidDestination();

    /// @notice Thrown when payment is attempted before validAfter timestamp
    error PaymentTooEarly();

    /// @notice Thrown when owner address is zero
    error InvalidOwner();

    /// @notice Thrown when settlement amount is zero
    error InvalidAmount();

    /// @notice Thrown when EIP-2612 permit value doesn't match Permit2 permitted amount
    error Permit2612AmountMismatch();

    /**
     * @notice EIP-2612 permit parameters grouped to reduce stack depth
     * @param value Approval amount for Permit2
     * @param deadline Permit expiration timestamp
     * @param r ECDSA signature parameter
     * @param s ECDSA signature parameter
     * @param v ECDSA signature parameter
     */
    struct EIP2612Permit {
        uint256 value;
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    /**
     * @notice Constructs the proxy with the Permit2 contract address
     * @param _permit2 Address of the Permit2 contract (canonical on all EVM chains)
     * @dev The Permit2 address is stored as an immutable, eliminating any post-deployment
     *      initialization race. Using the same canonical Permit2 address on every chain
     *      keeps the initCode identical, preserving CREATE2 address determinism.
     */
    constructor(
        address _permit2
    ) {
        if (_permit2 == address(0)) revert InvalidPermit2Address();
        PERMIT2 = ISignatureTransfer(_permit2);
    }

    /**
     * @notice Internal settlement logic shared by all settlement functions
     * @dev Validates common parameters and executes the Permit2 witness transfer.
     *      Each child contract computes its own witnessHash and witnessTypeString
     *      based on its Witness struct definition.
     * @param permit The Permit2 transfer authorization
     * @param settlementAmount The actual amount to transfer (may be <= permit.permitted.amount)
     * @param owner The token owner (payer)
     * @param to The destination address for the transfer
     * @param validAfter Earliest timestamp when payment can be settled
     * @param witnessHash The EIP-712 hash of the child's witness struct
     * @param witnessTypeString The EIP-712 type string for the child's witness
     * @param signature The payer's signature
     */
    function _settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        uint256 settlementAmount,
        address owner,
        address to,
        uint256 validAfter,
        bytes32 witnessHash,
        string memory witnessTypeString,
        bytes calldata signature
    ) internal {
        if (settlementAmount == 0) revert InvalidAmount();
        if (owner == address(0)) revert InvalidOwner();
        if (to == address(0)) revert InvalidDestination();
        if (block.timestamp < validAfter) revert PaymentTooEarly();

        ISignatureTransfer.SignatureTransferDetails memory transferDetails =
            ISignatureTransfer.SignatureTransferDetails({to: to, requestedAmount: settlementAmount});

        PERMIT2.permitWitnessTransferFrom(permit, transferDetails, owner, witnessHash, witnessTypeString, signature);
    }

    /**
     * @notice Validates and attempts to execute an EIP-2612 permit to approve Permit2
     * @dev Reverts if permit2612.value does not match permittedAmount.
     *      The actual permit call does not revert on failure because the approval
     *      might already exist or the token might not support EIP-2612.
     * @param token The token address
     * @param owner The token owner
     * @param permit2612 The EIP-2612 permit parameters
     * @param permittedAmount The Permit2 permitted amount
     */
    function _executePermit(
        address token,
        address owner,
        EIP2612Permit calldata permit2612,
        uint256 permittedAmount
    ) internal {
        if (permit2612.value != permittedAmount) {
            revert Permit2612AmountMismatch();
        }

        try IERC20Permit(token).permit(
            owner, address(PERMIT2), permit2612.value, permit2612.deadline, permit2612.v, permit2612.r, permit2612.s
        ) {
            // EIP-2612 permit succeeded
        } catch Error(string memory reason) {
            emit EIP2612PermitFailedWithReason(token, owner, reason);
        } catch Panic(uint256 errorCode) {
            emit EIP2612PermitFailedWithPanic(token, owner, errorCode);
        } catch (bytes memory data) {
            emit EIP2612PermitFailedWithData(token, owner, data);
        }
    }
}
