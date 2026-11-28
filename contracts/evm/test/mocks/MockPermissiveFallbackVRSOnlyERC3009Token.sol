// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockVRSOnlyERC3009Token} from "./MockVRSOnlyERC3009Token.sol";

contract MockPermissiveFallbackVRSOnlyERC3009Token is MockVRSOnlyERC3009Token {
    uint256 public fallbackCalls;

    fallback() external {
        fallbackCalls++;
    }
}
