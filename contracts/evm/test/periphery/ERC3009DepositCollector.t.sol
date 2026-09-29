// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC3009DepositCollector} from "../../src/periphery/ERC3009DepositCollector.sol";
import {DepositCollector} from "../../src/periphery/DepositCollector.sol";
import {MockERC3009Token} from "../mocks/MockERC3009Token.sol";

contract ERC3009DepositCollectorTest is Test {
    ERC3009DepositCollector public collector;
    MockERC3009Token public token;

    address public payer;

    uint256 constant AMOUNT = 1000e6;

    function setUp() public {
        collector = new ERC3009DepositCollector(address(this));
        token = new MockERC3009Token("USDC3009", "USDC3009", 6);

        payer = makeAddr("payer");

        token.mint(payer, 100_000e6);
    }

    function test_collect_success() public {
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 3600;
        uint256 salt = 1;
        bytes memory signature = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));

        bytes memory collectorData = abi.encode(validAfter, validBefore, salt, signature);

        collector.collect(payer, address(token), AMOUNT, bytes32(0), collectorData);

        assertEq(token.balanceOf(address(this)), AMOUNT);
        assertEq(token.balanceOf(payer), 100_000e6 - AMOUNT);
    }

    function test_collect_transfersViaCollector() public {
        bytes memory collectorData = abi.encode(
            uint256(0),
            uint256(block.timestamp + 3600),
            uint256(42),
            abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27))
        );

        uint256 collectorBalBefore = token.balanceOf(address(collector));
        collector.collect(payer, address(token), AMOUNT, bytes32(0), collectorData);
        uint256 collectorBalAfter = token.balanceOf(address(collector));

        assertEq(collectorBalAfter, collectorBalBefore);
        assertEq(token.balanceOf(address(this)), AMOUNT);
    }

    function test_collect_differentAmounts() public {
        uint128 smallAmount = 1e6;
        bytes memory collectorData = abi.encode(
            uint256(0),
            uint256(block.timestamp + 3600),
            uint256(100),
            abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27))
        );

        collector.collect(payer, address(token), smallAmount, bytes32(0), collectorData);
        assertEq(token.balanceOf(address(this)), smallAmount);
    }

    function test_collect_revert_onlyX402BatchSettlement() public {
        bytes memory collectorData = abi.encode(uint256(0), uint256(block.timestamp + 3600), uint256(1), hex"dead");

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(DepositCollector.OnlyX402BatchSettlement.selector);
        collector.collect(payer, address(token), AMOUNT, bytes32(0), collectorData);
    }
}
