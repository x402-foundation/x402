// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDepositCollector} from "../../src/interfaces/IDepositCollector.sol";

/// @notice Full-amount pull mock used by `x402BatchSettlement.t.sol`.
contract MockDepositCollector is IDepositCollector {
    function collect(address payer, address token, uint256 amount, bytes32, bytes calldata) external override {
        // Use a local for destination — identical gas semantics to GasMockDepositCollector but distinct bytecode
        // so `forge coverage` does not attribute all hits to the gas harness contract only.
        address to = msg.sender;
        IERC20(token).transferFrom(payer, to, amount);
    }
}

/// @notice Pulls half the requested amount — used to trigger `DepositCollectionFailed` in tests.
contract MockShortCollector is IDepositCollector {
    function collect(address payer, address token, uint256 amount, bytes32, bytes calldata) external override {
        IERC20(token).transferFrom(payer, msg.sender, amount / 2);
    }
}
