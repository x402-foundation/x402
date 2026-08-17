// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeployX402Proxies} from "../script/Deploy.s.sol";

contract DeployX402ProxiesArcForkTest is Test {
    uint256 constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant ARC_TESTNET_UPTO_ADDRESS = 0x402015c795ecb48A360bDC6e35a2EaEb313a0002;
    bytes32 constant UPTO_RUNTIME_CODE_HASH = 0xc858e50b1c4c2207d032578532415db2db50ed0ad509b67b8ac7200d771c70f3;

    modifier onlyArcFork() {
        if (block.chainid == 31_337) {
            vm.skip(true, "Run this test with --fork-url https://rpc.testnet.arc.network");
        }
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Run this test against Arc testnet");
        _;
    }

    function test_fork_arcUptoDeploymentAndValidation() public onlyArcFork {
        DeployX402Proxies deployer = new DeployX402Proxies();

        if (ARC_TESTNET_UPTO_ADDRESS.code.length == 0) {
            bytes memory deploymentData = deployer.prepareUptoArcTestnet();
            (bool success, bytes memory returnData) = CREATE2_DEPLOYER.call(deploymentData);

            assertTrue(success);
            assertEq(returnData.length, 20);

            address returnedAddress;
            assembly {
                returnedAddress := shr(96, mload(add(returnData, 32)))
            }
            assertEq(returnedAddress, ARC_TESTNET_UPTO_ADDRESS);
        }

        deployer.validateUptoArcTestnet();
        assertEq(ARC_TESTNET_UPTO_ADDRESS.codehash, UPTO_RUNTIME_CODE_HASH);

        vm.expectRevert("Upto target already occupied");
        deployer.prepareUptoArcTestnet();
    }
}
