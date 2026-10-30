// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Test} from "forge-std/Test.sol";

import {x402UptoERC3009Proxy} from "../src/x402UptoERC3009Proxy.sol";

interface IUSDC is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function authorizationState(
        address authorizer,
        bytes32 nonce
    ) external view returns (bool);

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

contract X402UptoERC3009ProxyForkTest is Test {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint256 internal constant PAYER_KEY = 0xA11CE;
    uint256 internal constant MAX_AMOUNT = 100e6;
    uint256 internal constant SETTLEMENT_AMOUNT = 60e6;

    x402UptoERC3009Proxy internal proxy;
    IUSDC internal usdc;

    address internal payer;
    address internal payTo;

    function setUp() public {
        if (block.chainid != 8453) return;

        payer = vm.addr(PAYER_KEY);
        payTo = makeAddr("payTo");
        proxy = new x402UptoERC3009Proxy();
        usdc = IUSDC(BASE_USDC);
        deal(BASE_USDC, payer, 1000e6);
    }

    modifier onlyBaseFork() {
        if (block.chainid != 8453) return;
        _;
    }

    function _payment(
        bytes32 salt
    )
        internal
        view
        returns (
            x402UptoERC3009Proxy.Authorization memory authorization,
            x402UptoERC3009Proxy.PaymentInfo memory paymentInfo,
            bytes memory signature
        )
    {
        paymentInfo = x402UptoERC3009Proxy.PaymentInfo({payTo: payTo, settler: address(this), salt: salt});
        bytes32 nonce =
            keccak256(abi.encode(proxy.NONCE_TYPEHASH(), paymentInfo.payTo, paymentInfo.settler, paymentInfo.salt));
        authorization = x402UptoERC3009Proxy.Authorization({
            from: payer,
            to: address(proxy),
            value: MAX_AMOUNT,
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce
        });
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                authorization.from,
                authorization.to,
                authorization.value,
                authorization.validAfter,
                authorization.validBefore,
                authorization.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function test_fork_settle_paysAndRefundsRealUSDC() public onlyBaseFork {
        (
            x402UptoERC3009Proxy.Authorization memory authorization,
            x402UptoERC3009Proxy.PaymentInfo memory paymentInfo,
            bytes memory signature
        ) = _payment(bytes32("partial"));
        uint256 payerBefore = usdc.balanceOf(payer);

        proxy.settle(BASE_USDC, SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);

        assertEq(usdc.balanceOf(payTo), SETTLEMENT_AMOUNT);
        assertEq(usdc.balanceOf(payer), payerBefore - SETTLEMENT_AMOUNT);
        assertEq(usdc.balanceOf(address(proxy)), 0);
        assertTrue(usdc.authorizationState(payer, authorization.nonce));
    }

    function test_fork_settle_revertsOnReplay() public onlyBaseFork {
        (
            x402UptoERC3009Proxy.Authorization memory authorization,
            x402UptoERC3009Proxy.PaymentInfo memory paymentInfo,
            bytes memory signature
        ) = _payment(bytes32("replay"));

        proxy.settle(BASE_USDC, SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);

        vm.expectRevert();
        proxy.settle(BASE_USDC, SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);
    }

    function test_fork_settle_revertsWhenPaymentInfoIsTampered() public onlyBaseFork {
        (
            x402UptoERC3009Proxy.Authorization memory authorization,
            x402UptoERC3009Proxy.PaymentInfo memory paymentInfo,
            bytes memory signature
        ) = _payment(bytes32("tamper"));
        paymentInfo.payTo = makeAddr("attacker");

        vm.expectRevert(x402UptoERC3009Proxy.InvalidNonce.selector);
        proxy.settle(BASE_USDC, SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);
    }

    function test_fork_receiveWithAuthorization_revertsWhenFrontRun() public onlyBaseFork {
        (x402UptoERC3009Proxy.Authorization memory authorization,, bytes memory signature) =
            _payment(bytes32("front-run"));

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(
            authorization.from,
            authorization.to,
            authorization.value,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            signature
        );
    }
}
