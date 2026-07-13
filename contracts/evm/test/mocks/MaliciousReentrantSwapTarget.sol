// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Swap target that attempts to re-enter the settler during the route call.
 *      Tests whitelist it both as swap target and as facilitator (a colluding-facilitator
 *      scenario) to prove that even an authorized caller cannot re-enter settlement
 *      mid-swap: the inner call must revert with ReentrancyGuardReentrantCall, which this
 *      contract bubbles up so the outer settlement fails with SwapCallFailed.
 */
contract MaliciousReentrantSwapTarget {
    address public settler;
    bytes public reentryCalldata;

    function setAttack(address _settler, bytes calldata _reentryCalldata) external {
        settler = _settler;
        reentryCalldata = _reentryCalldata;
    }

    function swap(address, address) external {
        (bool ok, bytes memory ret) = settler.call(reentryCalldata);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
