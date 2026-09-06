// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {x402ExactPermit2Proxy} from "../../src/x402ExactPermit2Proxy.sol";
import {x402BasePermit2Proxy} from "../../src/x402BasePermit2Proxy.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract X402ExactHandler is Test {
    x402ExactPermit2Proxy public proxy;
    MockPermit2 public mockPermit2;
    MockERC20 public token;

    address public payer;
    address public recipient;

    uint256 public totalSettled;
    uint256 public settleCallCount;

    constructor(
        x402ExactPermit2Proxy _proxy,
        MockPermit2 _mockPermit2,
        MockERC20 _token,
        address _payer,
        address _recipient
    ) {
        proxy = _proxy;
        mockPermit2 = _mockPermit2;
        token = _token;
        payer = _payer;
        recipient = _recipient;
    }

    function settle(uint256 amount, uint256 nonce) external {
        amount = bound(amount, 0, token.balanceOf(payer));
        if (amount == 0) return;

        uint256 t = block.timestamp;

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: amount}),
            nonce: nonce,
            deadline: t + 3600
        });

        x402ExactPermit2Proxy.Witness memory witness =
            x402ExactPermit2Proxy.Witness({to: recipient, validAfter: t > 60 ? t - 60 : 0});

        bytes memory sig = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));

        try proxy.settle(permit, payer, witness, sig) {
            totalSettled += amount;
            settleCallCount++;
        } catch {}
    }
}

contract X402ExactInvariantsTest is Test {
    x402ExactPermit2Proxy public proxy;
    MockPermit2 public mockPermit2;
    MockERC20 public token;
    X402ExactHandler public handler;

    address public payer;
    address public recipient;

    uint256 constant MINT_AMOUNT = 1_000_000e6;

    function setUp() public {
        payer = makeAddr("payer");
        recipient = makeAddr("recipient");

        mockPermit2 = new MockPermit2();
        proxy = new x402ExactPermit2Proxy(address(mockPermit2));
        token = new MockERC20("USDC", "USDC", 6);

        token.mint(payer, MINT_AMOUNT);
        vm.prank(payer);
        token.approve(address(mockPermit2), type(uint256).max);
        mockPermit2.setShouldActuallyTransfer(true);

        handler = new X402ExactHandler(proxy, mockPermit2, token, payer, recipient);
        targetContract(address(handler));
    }

    /// @notice Proxy must never hold tokens - all transfers go directly to recipient
    function invariant_proxyNeverHoldsTokens() public view {
        assertEq(token.balanceOf(address(proxy)), 0);
    }

    /// @notice Total settled cannot exceed minted supply
    function invariant_settledNeverExceedsMinted() public view {
        assertLe(handler.totalSettled(), MINT_AMOUNT);
    }

    /// @notice Token conservation: sum of all balances equals minted amount
    function invariant_tokenConservation() public view {
        uint256 total = token.balanceOf(payer) + token.balanceOf(recipient) + token.balanceOf(address(proxy))
            + token.balanceOf(address(mockPermit2));
        assertEq(total, MINT_AMOUNT);
    }
}
