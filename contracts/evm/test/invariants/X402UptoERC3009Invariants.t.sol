// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {x402UptoERC3009Proxy} from "../../src/x402UptoERC3009Proxy.sol";

import {MockValidatingERC3009Token} from "../mocks/MockValidatingERC3009Token.sol";

contract X402UptoERC3009Handler is Test {
    x402UptoERC3009Proxy public proxy;
    MockValidatingERC3009Token public token;

    uint256 public payerKey;
    address public payer;
    address public payTo;
    uint256 public totalSettled;
    uint256 public nonceIndex;

    constructor(
        x402UptoERC3009Proxy proxy_,
        MockValidatingERC3009Token token_,
        uint256 payerKey_,
        address payTo_
    ) {
        proxy = proxy_;
        token = token_;
        payerKey = payerKey_;
        payer = vm.addr(payerKey_);
        payTo = payTo_;
    }

    function settle(
        uint256 amount,
        uint256 maximum,
        bytes32 saltSeed
    ) external {
        uint256 balance = token.balanceOf(payer);
        if (balance == 0) return;

        maximum = bound(maximum, 1, balance);
        amount = bound(amount, 1, maximum);
        bytes32 salt = keccak256(abi.encode(saltSeed, nonceIndex++));
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo =
            x402UptoERC3009Proxy.PaymentInfo({payTo: payTo, settler: address(this), salt: salt});
        bytes32 nonce =
            keccak256(abi.encode(proxy.NONCE_TYPEHASH(), paymentInfo.payTo, paymentInfo.settler, paymentInfo.salt));
        x402UptoERC3009Proxy.Authorization memory authorization = x402UptoERC3009Proxy.Authorization({
            from: payer,
            to: address(proxy),
            value: maximum,
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce
        });
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                authorization.from,
                authorization.to,
                authorization.value,
                authorization.validAfter,
                authorization.validBefore,
                authorization.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);

        proxy.settle(address(token), amount, authorization, paymentInfo, abi.encodePacked(r, s, v));
        totalSettled += amount;
    }
}

contract X402UptoERC3009InvariantsTest is Test {
    uint256 internal constant PAYER_KEY = 0xA11CE;
    uint256 internal constant MINT_AMOUNT = 1_000_000e6;

    x402UptoERC3009Proxy internal proxy;
    MockValidatingERC3009Token internal token;
    X402UptoERC3009Handler internal handler;

    address internal payer;
    address internal payTo;

    function setUp() public {
        vm.warp(1_000_000);

        payer = vm.addr(PAYER_KEY);
        payTo = makeAddr("payTo");
        proxy = new x402UptoERC3009Proxy();
        token = new MockValidatingERC3009Token();
        token.mint(payer, MINT_AMOUNT);

        handler = new X402UptoERC3009Handler(proxy, token, PAYER_KEY, payTo);
        targetContract(address(handler));
    }

    function invariant_proxyNeverRetainsSettlementFunds() public view {
        assertEq(token.balanceOf(address(proxy)), 0);
    }

    function invariant_recipientBalanceEqualsTotalSettled() public view {
        assertEq(token.balanceOf(payTo), handler.totalSettled());
    }

    function invariant_tokenValueIsConserved() public view {
        assertEq(token.balanceOf(payer) + token.balanceOf(payTo) + token.balanceOf(address(proxy)), MINT_AMOUNT);
    }
}
