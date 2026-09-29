// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {MockGenericERC20} from "../src/mocks/MockGenericERC20.sol";

/**
 * @title DeployMockGenericERC20
 * @notice Deterministic CREATE2 deployment for MockGenericERC20
 * @dev Run with: forge script script/DeployMockGenericERC20.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --verify
 *
 *      Because MockGenericERC20 has no constructor arguments, initCode == creationCode,
 *      giving a single deterministic address across all EVM chains.
 */
contract DeployMockGenericERC20 is Script {
    /// @notice Arachnid's deterministic CREATE2 deployer (same on all EVM chains)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Salt for deterministic deployment
    bytes32 constant SALT = 0x0000000000000000000000000000000000000000000000000000000000000402;

    function run() public {
        console2.log("");
        console2.log("============================================================");
        console2.log("  MockGenericERC20 Deterministic Deployment (CREATE2)");
        console2.log("============================================================");
        console2.log("");

        console2.log("Network: chainId", block.chainid);
        console2.log("CREATE2 Deployer:", CREATE2_DEPLOYER);
        console2.log("Salt:", vm.toString(SALT));
        console2.log("");

        bytes memory initCode = type(MockGenericERC20).creationCode;
        bytes32 initCodeHash = keccak256(initCode);
        address expectedAddress = _computeCreate2Addr(SALT, initCodeHash, CREATE2_DEPLOYER);

        console2.log("Expected address:", expectedAddress);
        console2.log("Init code hash:", vm.toString(initCodeHash));

        if (expectedAddress.code.length > 0) {
            console2.log("Contract already deployed at", expectedAddress);
            return;
        }

        if (block.chainid != 31_337 && block.chainid != 1337) {
            require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer not found on this network");
            console2.log("CREATE2 deployer verified");
        }

        vm.startBroadcast();

        address deployedAddress;
        if (block.chainid == 31_337 || block.chainid == 1337) {
            console2.log("(Using regular deployment for local network)");
            MockGenericERC20 token = new MockGenericERC20();
            deployedAddress = address(token);
        } else {
            bytes memory deploymentData = abi.encodePacked(SALT, initCode);
            (bool success,) = CREATE2_DEPLOYER.call(deploymentData);
            require(success, "CREATE2 deployment failed for MockGenericERC20");
            deployedAddress = expectedAddress;
            require(deployedAddress.code.length > 0, "No bytecode at expected address");
        }

        vm.stopBroadcast();

        console2.log("Deployed to:", deployedAddress);
        console2.log("");
    }

    function _computeCreate2Addr(
        bytes32 salt,
        bytes32 initCodeHash,
        address deployer
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
