// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract ValidateArcDeploymentForkTest is Test {
    uint256 constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ARC_TESTNET_UPTO_ADDRESS = 0x402015c795ecb48A360bDC6e35a2EaEb313a0002;
    bytes32 constant UPTO_RUNTIME_CODE_HASH = 0xc858e50b1c4c2207d032578532415db2db50ed0ad509b67b8ac7200d771c70f3;

    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 constant PERMIT_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)"
    );
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    uint256 constant PAYER_KEY = uint256(keccak256("arc-deployment-validator-payer"));

    modifier onlyArcFork() {
        if (block.chainid == 31_337) {
            vm.skip(true, "Run this test with --fork-url https://rpc.testnet.arc.network");
        }
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Run this test against Arc testnet");
        _;
    }

    function _sign(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        x402UptoPermit2Proxy.Witness memory witness
    ) internal view returns (bytes memory) {
        x402UptoPermit2Proxy proxy = x402UptoPermit2Proxy(ARC_TESTNET_UPTO_ADDRESS);
        bytes32 domainSeparator = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, PERMIT2));
        bytes32 witnessHash =
            keccak256(abi.encode(proxy.WITNESS_TYPEHASH(), witness.to, witness.facilitator, witness.validAfter));
        bytes32 tokenHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, tokenHash, address(proxy), nonce, deadline, witnessHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_fork_deployedArcUptoPartialSettlement() public onlyArcFork {
        require(ARC_TESTNET_UPTO_ADDRESS.codehash == UPTO_RUNTIME_CODE_HASH, "Canonical Upto proxy not deployed");

        x402UptoPermit2Proxy proxy = x402UptoPermit2Proxy(ARC_TESTNET_UPTO_ADDRESS);
        require(address(proxy.PERMIT2()) == PERMIT2, "Upto PERMIT2 mismatch");

        MockERC20 token = new MockERC20("USDC", "USDC", 6);
        address payer = vm.addr(PAYER_KEY);
        address recipient = makeAddr("arc-deployment-validator-recipient");
        uint256 permittedAmount = 100e6;
        uint256 settlementAmount = 40e6;

        token.mint(payer, permittedAmount);
        vm.prank(payer);
        token.approve(PERMIT2, permittedAmount);

        uint256 nonce = uint256(keccak256(abi.encodePacked(block.number, address(this))));
        uint256 deadline = block.timestamp + 1 hours;
        x402UptoPermit2Proxy.Witness memory witness =
            x402UptoPermit2Proxy.Witness({to: recipient, facilitator: address(this), validAfter: block.timestamp - 1});

        bytes memory signature = _sign(address(token), permittedAmount, nonce, deadline, witness);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: permittedAmount}),
            nonce: nonce,
            deadline: deadline
        });

        proxy.settle(permit, settlementAmount, payer, witness, signature);

        assertEq(token.balanceOf(recipient), settlementAmount);
        assertEq(token.balanceOf(payer), permittedAmount - settlementAmount);
        assertEq(token.balanceOf(ARC_TESTNET_UPTO_ADDRESS), 0);
    }
}
