// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDepositCollector} from "../../src/interfaces/IDepositCollector.sol";

/// @notice Gas harness collector for `x402BatchSettlement.gas.t.sol` only (kept separate so forge coverage
///         does not merge its bytecode with `MockDepositCollector` in `MockBatchDepositCollectors.sol`).
contract GasMockDepositCollector is IDepositCollector {
    function collect(address payer, address token, uint256 amount, bytes32, bytes calldata) external override {
        IERC20(token).transferFrom(payer, msg.sender, amount);
    }
}
