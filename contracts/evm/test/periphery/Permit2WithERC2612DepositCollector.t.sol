// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Permit2DepositCollector} from "../../src/periphery/Permit2DepositCollector.sol";
import {DepositCollector} from "../../src/periphery/DepositCollector.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockERC20Permit} from "../mocks/MockERC20Permit.sol";

/// @dev Optional EIP-2612 segment on merged `Permit2DepositCollector`.
contract Permit2WithERC2612DepositCollectorTest is Test {
    Permit2DepositCollector public collector;
    MockPermit2 public mockPermit2;
    MockERC20Permit public token;

    address public payer;

    uint256 constant AMOUNT = 1000e6;

    event EIP2612PermitFailedWithReason(address indexed token, address indexed owner, string reason);
    event EIP2612PermitFailedWithPanic(address indexed token, address indexed owner, uint256 errorCode);
    event EIP2612PermitFailedWithData(address indexed token, address indexed owner, bytes data);

    function setUp() public {
        mockPermit2 = new MockPermit2();
        collector = new Permit2DepositCollector(address(this), address(mockPermit2));
        token = new MockERC20Permit("PermitUSDC", "pUSDC", 6);

        payer = makeAddr("payer");

        token.mint(payer, 100_000e6);

        vm.prank(payer);
        token.approve(address(mockPermit2), type(uint256).max);
        mockPermit2.setShouldActuallyTransfer(true);
    }

    function _makeCollectorData(
        uint256 amount
    ) internal view returns (bytes memory) {
        bytes memory eip2612 = abi.encode(amount, block.timestamp + 3600, uint8(27), bytes32(0), bytes32(0));
        bytes memory signature = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));
        return abi.encode(uint256(0), block.timestamp + 3600, signature, eip2612);
    }

    function test_constructor_setsPermit2() public view {
        assertEq(address(collector.PERMIT2()), address(mockPermit2));
    }

    function test_constructor_revert_zeroPermit2() public {
        vm.expectRevert(Permit2DepositCollector.InvalidPermit2Address.selector);
        new Permit2DepositCollector(address(this), address(0));
    }

    function test_collect_success() public {
        bytes memory collectorData = _makeCollectorData(AMOUNT);
        bytes32 channelId = keccak256("test-channel");

        collector.collect(payer, address(token), AMOUNT, channelId, collectorData);

        assertEq(token.balanceOf(address(this)), AMOUNT);
        assertEq(token.balanceOf(payer), 100_000e6 - AMOUNT);
    }

    function test_collect_softFail_revertWithReason() public {
        token.setPermitRevert(true, "ERC20Permit: invalid signature");

        bytes memory collectorData = _makeCollectorData(AMOUNT);
        bytes32 channelId = keccak256("test-channel");

        vm.expectEmit(true, true, false, true);
        emit EIP2612PermitFailedWithReason(address(token), payer, "ERC20Permit: invalid signature");

        collector.collect(payer, address(token), AMOUNT, channelId, collectorData);

        assertEq(token.balanceOf(address(this)), AMOUNT);
    }

    function test_collect_softFail_panic() public {
        token.setRevertMode(MockERC20Permit.RevertMode.Panic);

        bytes memory collectorData = _makeCollectorData(AMOUNT);
        bytes32 channelId = keccak256("test-channel");

        vm.expectEmit(true, true, false, true);
        emit EIP2612PermitFailedWithPanic(address(token), payer, 0x12);

        collector.collect(payer, address(token), AMOUNT, channelId, collectorData);

        assertEq(token.balanceOf(address(this)), AMOUNT);
    }

    function test_collect_softFail_customError() public {
        token.setRevertMode(MockERC20Permit.RevertMode.CustomError);

        bytes memory collectorData = _makeCollectorData(AMOUNT);
        bytes32 channelId = keccak256("test-channel");

        collector.collect(payer, address(token), AMOUNT, channelId, collectorData);

        assertEq(token.balanceOf(address(this)), AMOUNT);
    }

    function test_collect_revert_amountMismatch() public {
        bytes memory eip2612 = abi.encode(AMOUNT + 1, block.timestamp + 3600, uint8(27), bytes32(0), bytes32(0));
        bytes memory signature = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));
        bytes memory collectorData = abi.encode(uint256(0), block.timestamp + 3600, signature, eip2612);

        vm.expectRevert(Permit2DepositCollector.Permit2612AmountMismatch.selector);
        collector.collect(payer, address(token), AMOUNT, keccak256("ch"), collectorData);
    }

    function test_collect_revert_onlyX402BatchSettlement() public {
        bytes memory collectorData = _makeCollectorData(AMOUNT);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(DepositCollector.OnlyX402BatchSettlement.selector);
        collector.collect(payer, address(token), AMOUNT, keccak256("ch"), collectorData);
    }
}
