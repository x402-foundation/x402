// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @dev Minimal HTS facade of a fungible token (HIP-218).
interface IHtsToken {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title MockTransferExecutor
 * @notice INTEGRATION-TEST CONTRACT ONLY. NOT AUDITED. DO NOT USE IN PRODUCTION.
 *
 *         NOT REPRESENTATIVE OF A REAL EXECUTOR. The spec defines no canonical executor, and this
 *         is not one, a reference, or a template. A real executor authenticates its caller's
 *         authorization and binds it to the transfer; this one performs no authorization at all,
 *         and anyone can call it. It exists only so the facilitator's verify, settle and record
 *         checks can be exercised against a real network, one misbehaviour per call.
 *
 *         The behaviour of each call is chosen by the `authorization` bytes. It pays from its OWN
 *         balance, so the payer of a payment is this contract's account id. It holds HBAR (and
 *         associated HTS tokens) deposited beforehand, and must never hold more than test funds.
 *
 * authorization = abi.encode(uint8 mode, uint256 validBefore, bytes32 binding, bytes32 nonce)
 *
 *   binding = keccak256(abi.encode(from, asset, to, amount)), the transfer the
 *             authorization was prepared for. A mismatch reverts, standing in for the binding
 *             a real executor does cryptographically.
 *   nonce   = makes the authorization unique, so one value settles once.
 */
contract MockTransferExecutor {
    /// Moves exactly `amount` to `to` and consumes the authorization.
    uint8 public constant OK = 0;
    /// Reverts: a failed simulation and a failed settlement.
    uint8 public constant REVERT = 1;
    /// Returns without moving anything: SUCCESS receipt, no transfer.
    uint8 public constant NOOP = 2;
    /// Pays `amount + 1`.
    uint8 public constant OVERPAY = 3;
    /// Pays `amount`, then `1` more to the extra recipient.
    uint8 public constant EXTRA_CREDIT = 4;
    /// Pays `amount`, then emits an ERC-20 `Transfer` log whose sender is the caller.
    uint8 public constant LOG_CALLER_TRANSFER = 5;
    /// Pays `amount` without consuming the authorization: replayable.
    uint8 public constant OK_NO_CONSUME = 6;
    /// Spends all the gas it is given and fails out of gas, with no revert reason.
    uint8 public constant BURN_GAS = 7;
    /// Pays `amount - 1`.
    uint8 public constant UNDERPAY = 8;
    /// Pays `amount` and burns gas in the same call without reverting.
    uint8 public constant OK_THEN_BURN_GAS = 9;

    /// HTS system contract, which hosts `associateToken`.
    address private constant HTS = address(0x167);

    bytes32 private constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");

    /// Authorizations that were consumed by a successful call.
    mapping(bytes32 => bool) public consumed;

    /// Recipient of `EXTRA_CREDIT`.
    address public extraRecipient;

    event Executed(address indexed from, address indexed asset, address indexed to, uint256 amount, uint8 mode);

    constructor(address extraRecipient_) {
        extraRecipient = extraRecipient_;
    }

    receive() external payable {}

    /// Associates this contract with an HTS token so it can hold and send it.
    function associate(address token) external returns (int64 responseCode) {
        (bool ok, bytes memory ret) =
            HTS.call(abi.encodeWithSignature("associateToken(address,address)", address(this), token));
        require(ok && ret.length >= 32, "associate failed");
        responseCode = abi.decode(ret, (int64));
    }

    /// Returns the `binding` an authorization for this exact transfer must carry.
    function bindingOf(address from, address asset, address to, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode(from, asset, to, amount));
    }

    function executeTransfer(address from, address asset, address to, uint256 amount, bytes calldata authorization)
        external
    {
        (uint8 mode, uint256 validBefore, bytes32 binding,) =
            abi.decode(authorization, (uint8, uint256, bytes32, bytes32));

        require(block.timestamp <= validBefore, "authorization expired");
        require(binding == bindingOf(from, asset, to, amount), "authorization does not match transfer");
        bytes32 id = keccak256(authorization);
        require(!consumed[id], "authorization consumed");

        if (mode == REVERT) revert("mock: forced revert");
        if (mode == BURN_GAS) _burnAllGas();
        if (mode == NOOP) {
            // Success with no movement, and the authorization is spent.
            consumed[id] = true;
            return;
        }

        uint256 paid = amount;
        if (mode == OVERPAY) paid = amount + 1;
        if (mode == UNDERPAY) paid = amount - 1;
        _pay(asset, to, paid);

        if (mode == EXTRA_CREDIT) _pay(asset, extraRecipient, 1);
        if (mode == LOG_CALLER_TRANSFER) emit Transfer(msg.sender, to, 1);
        if (mode == OK_THEN_BURN_GAS) _burnGas();

        if (mode != OK_NO_CONSUME) consumed[id] = true;
        emit Executed(from, asset, to, amount, mode);
    }

    /// ERC-20 `Transfer`, declared so the mock can emit a log the facilitator should flag.
    event Transfer(address indexed from, address indexed to, uint256 value);

    function _pay(address asset, address to, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            require(ok, "hbar transfer failed");
        } else {
            require(IHtsToken(asset).transfer(to, amount), "token transfer failed");
        }
    }

    /// Loops until the call runs out of gas, so the call fails without a revert reason.
    function _burnAllGas() private pure {
        uint256 sink;
        unchecked {
            while (true) {
                sink = uint256(keccak256(abi.encode(sink)));
            }
        }
    }

    /// Spends gas down to a floor and returns, so the call still succeeds.
    function _burnGas() private view {
        uint256 sink;
        while (gasleft() > 20_000) {
            sink = uint256(keccak256(abi.encode(sink, gasleft())));
        }
        sink; // silence the unused warning
    }
}
