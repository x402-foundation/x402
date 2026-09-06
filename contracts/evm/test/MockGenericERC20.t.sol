// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockGenericERC20} from "../src/mocks/MockGenericERC20.sol";

contract MockGenericERC20Test is Test {
    function test_metadata_andMint() public {
        MockGenericERC20 token = new MockGenericERC20();
        assertEq(token.name(), "Mock Generic ERC20");
        assertEq(token.symbol(), "MOCK");
        assertEq(token.decimals(), 6);

        address user = makeAddr("user");
        token.mint(user, 1000e6);
        assertEq(token.balanceOf(user), 1000e6);
    }
}
