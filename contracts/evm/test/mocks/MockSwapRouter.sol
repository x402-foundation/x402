// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Configurable mock swap target for x402SwapSettler tests.
 *      `swap` pulls `spendAmount` of the input token from the caller (via the caller's
 *      approval), sends `giveAmount` of the output token to the caller, and optionally
 *      "donates" extra input tokens back to the caller. Must be pre-funded with output
 *      (and donation) tokens by the test.
 */
contract MockSwapRouter {
    uint256 public spendAmount;
    uint256 public giveAmount;
    uint256 public donateInputAmount;
    bool public shouldRevert;

    function setBehavior(uint256 _spendAmount, uint256 _giveAmount) external {
        spendAmount = _spendAmount;
        giveAmount = _giveAmount;
    }

    function setDonateInput(
        uint256 _amount
    ) external {
        donateInputAmount = _amount;
    }

    function setShouldRevert(
        bool _shouldRevert
    ) external {
        shouldRevert = _shouldRevert;
    }

    function swap(address inputToken, address outputToken) external {
        if (shouldRevert) revert("MockSwapRouter: forced revert");
        if (spendAmount > 0) {
            require(IERC20(inputToken).transferFrom(msg.sender, address(this), spendAmount), "pull failed");
        }
        if (giveAmount > 0) {
            require(IERC20(outputToken).transfer(msg.sender, giveAmount), "give failed");
        }
        if (donateInputAmount > 0) {
            require(IERC20(inputToken).transfer(msg.sender, donateInputAmount), "donate failed");
        }
    }
}
