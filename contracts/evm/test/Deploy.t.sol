// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeployX402Proxies} from "../script/Deploy.s.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";

contract DeployX402ProxiesTest is Test {
    uint256 constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant ARC_TESTNET_UPTO_ADDRESS = 0x402015c795ecb48A360bDC6e35a2EaEb313a0002;
    bytes32 constant UPTO_SALT = 0x0000000000000000000000000000000000000000000000000800000007e2e4de;
    bytes32 constant UPTO_INIT_CODE_HASH = 0x01575bfc9cacbf6463db62ee8867594b1657139c8493a712ef6bcefa848a20b7;
    bytes32 constant UPTO_RUNTIME_CODE_HASH = 0xc858e50b1c4c2207d032578532415db2db50ed0ad509b67b8ac7200d771c70f3;

    DeployX402Proxies internal deployer;

    function setUp() public {
        deployer = new DeployX402Proxies();
    }

    function test_uptoArcTestnetDeploymentDataMatchesPinnedArtifact() public view {
        bytes memory initCode = abi.encodePacked(type(x402UptoPermit2Proxy).creationCode, abi.encode(CANONICAL_PERMIT2));
        bytes memory expectedDeploymentData = abi.encodePacked(UPTO_SALT, initCode);
        bytes memory deploymentData = deployer.uptoArcTestnetDeploymentData();

        assertEq(keccak256(initCode), UPTO_INIT_CODE_HASH);
        assertEq(keccak256(deploymentData), keccak256(expectedDeploymentData));

        address expectedAddress = address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, UPTO_SALT, UPTO_INIT_CODE_HASH)))
            )
        );
        assertEq(expectedAddress, ARC_TESTNET_UPTO_ADDRESS);
    }

    function test_uptoRuntimeMatchesPinnedArtifact() public {
        x402UptoPermit2Proxy proxy = new x402UptoPermit2Proxy(CANONICAL_PERMIT2);
        assertEq(address(proxy).codehash, UPTO_RUNTIME_CODE_HASH);
        assertEq(address(proxy.PERMIT2()), CANONICAL_PERMIT2);
    }

    function test_prepareUptoArcTestnetRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert("Arc testnet chain ID mismatch");
        deployer.prepareUptoArcTestnet();
    }

    function test_prepareUptoArcTestnetRejectsWrongFactoryCode() public {
        vm.chainId(ARC_TESTNET_CHAIN_ID);
        vm.etch(CREATE2_DEPLOYER, hex"00");
        vm.expectRevert("CREATE2 deployer code hash mismatch");
        deployer.prepareUptoArcTestnet();
    }

    function test_prepareUptoArcTestnetRejectsWrongPermit2Code() public {
        vm.chainId(ARC_TESTNET_CHAIN_ID);
        vm.expectRevert("Permit2 runtime code hash mismatch");
        deployer.prepareUptoArcTestnet();
    }
}
