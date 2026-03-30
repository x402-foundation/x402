// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";

/**
 * @title DeployX402Proxies
 * @notice Deployment script for x402 Permit2 Proxy contracts using CREATE2
 * @dev Run with: forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
 *
 *      The Permit2 address is passed as a constructor argument. Since Permit2 is
 *      deployed via a deterministic CREATE2 deployer, its canonical address
 *      (0x000000000022D473030F116dDEE9F6B43aC78BA3) is the same on all EVM chains.
 *      Using the same constructor argument on every chain keeps the initCode identical,
 *      preserving a uniform CREATE2 address for these proxies across all chains.
 *
 *      If Permit2 has not yet been deployed on the target chain, deploy it first
 *      using the canonical Permit2 deployment method before running this script.
 */
contract DeployX402Proxies is Script {
    /// @notice Canonical Permit2 address (Uniswap's official deployment)
    /// @dev Override via environment variable PERMIT2_ADDRESS for chains with different Permit2
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Arachnid's deterministic CREATE2 deployer (same on all EVM chains)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Salt for x402ExactPermit2Proxy deterministic deployment
    /// @dev Vanity mined for address 0x402085c248eea27d92e8b30b2c58ed07f9e20001
    bytes32 constant EXACT_SALT = 0x0000000000000000000000000000000000000000000000003000000007263b0e;

    /// @notice Salt for x402UptoPermit2Proxy deterministic deployment
    /// @dev Vanity mined for address 0x402039b3d6e6bec5a02c2c9fd937ac17a6940002
    bytes32 constant UPTO_SALT = 0x0000000000000000000000000000000000000000000000000000000000edb738;

    function run() public {
        // Allow override of Permit2 address for chains with non-canonical deployments
        address permit2 = vm.envOr("PERMIT2_ADDRESS", CANONICAL_PERMIT2);

        console2.log("");
        console2.log("============================================================");
        console2.log("  x402 Permit2 Proxies Deterministic Deployment (CREATE2)");
        console2.log("============================================================");
        console2.log("");

        // Log configuration
        console2.log("Network: chainId", block.chainid);
        console2.log("Permit2:", permit2);
        console2.log("CREATE2 Deployer:", CREATE2_DEPLOYER);
        console2.log("");

        // Verify Permit2 exists (skip for local networks)
        if (block.chainid != 31_337 && block.chainid != 1337) {
            require(permit2.code.length > 0, "Permit2 not found on this network");
            console2.log("Permit2 verified");

            require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer not found on this network");
            console2.log("CREATE2 deployer verified");
        }

        // Deploy both contracts (Permit2 address is a constructor arg, no initialization needed)
        _deployExact(permit2);
        _deployUpto(permit2);

        console2.log("");
        console2.log("All deployments complete!");
        console2.log("");
    }

    function _deployExact(
        address permit2
    ) internal {
        console2.log("");
        console2.log("------------------------------------------------------------");
        console2.log("  Deploying x402ExactPermit2Proxy");
        console2.log("------------------------------------------------------------");

        // Constructor arg is the canonical Permit2 address (same on all chains)
        bytes memory initCode = abi.encodePacked(type(x402ExactPermit2Proxy).creationCode, abi.encode(permit2));
        bytes32 initCodeHash = keccak256(initCode);
        address expectedAddress = _computeCreate2Addr(EXACT_SALT, initCodeHash, CREATE2_DEPLOYER);

        console2.log("Salt:", vm.toString(EXACT_SALT));
        console2.log("Expected address:", expectedAddress);
        console2.log("Init code hash:", vm.toString(initCodeHash));

        x402ExactPermit2Proxy proxy;

        if (expectedAddress.code.length > 0) {
            console2.log("Contract already deployed at", expectedAddress);
            proxy = x402ExactPermit2Proxy(expectedAddress);
            console2.log("PERMIT2:", address(proxy.PERMIT2()));
            return;
        }

        vm.startBroadcast();

        address deployedAddress;
        if (block.chainid == 31_337 || block.chainid == 1337) {
            console2.log("(Using regular deployment for local network)");
            proxy = new x402ExactPermit2Proxy(permit2);
            deployedAddress = address(proxy);
        } else {
            bytes memory deploymentData = abi.encodePacked(EXACT_SALT, initCode);
            (bool success,) = CREATE2_DEPLOYER.call(deploymentData);
            require(success, "CREATE2 deployment failed for Exact");
            deployedAddress = expectedAddress;
            require(deployedAddress.code.length > 0, "No bytecode at expected address");
            proxy = x402ExactPermit2Proxy(deployedAddress);
        }

        vm.stopBroadcast();

        console2.log("Deployed to:", deployedAddress);
        console2.log("Verification - PERMIT2:", address(proxy.PERMIT2()));
        require(address(proxy.PERMIT2()) == permit2, "PERMIT2 mismatch");
    }

    function _deployUpto(
        address permit2
    ) internal {
        console2.log("");
        console2.log("------------------------------------------------------------");
        console2.log("  Deploying x402UptoPermit2Proxy");
        console2.log("------------------------------------------------------------");

        // Constructor arg is the canonical Permit2 address (same on all chains)
        bytes memory initCode = abi.encodePacked(type(x402UptoPermit2Proxy).creationCode, abi.encode(permit2));
        bytes32 initCodeHash = keccak256(initCode);
        address expectedAddress = _computeCreate2Addr(UPTO_SALT, initCodeHash, CREATE2_DEPLOYER);

        console2.log("Salt:", vm.toString(UPTO_SALT));
        console2.log("Expected address:", expectedAddress);
        console2.log("Init code hash:", vm.toString(initCodeHash));

        x402UptoPermit2Proxy proxy;

        if (expectedAddress.code.length > 0) {
            console2.log("Contract already deployed at", expectedAddress);
            proxy = x402UptoPermit2Proxy(expectedAddress);
            console2.log("PERMIT2:", address(proxy.PERMIT2()));
            return;
        }

        vm.startBroadcast();

        address deployedAddress;
        if (block.chainid == 31_337 || block.chainid == 1337) {
            console2.log("(Using regular deployment for local network)");
            proxy = new x402UptoPermit2Proxy(permit2);
            deployedAddress = address(proxy);
        } else {
            bytes memory deploymentData = abi.encodePacked(UPTO_SALT, initCode);
            (bool success,) = CREATE2_DEPLOYER.call(deploymentData);
            require(success, "CREATE2 deployment failed for Upto");
            deployedAddress = expectedAddress;
            require(deployedAddress.code.length > 0, "No bytecode at expected address");
            proxy = x402UptoPermit2Proxy(deployedAddress);
        }

        vm.stopBroadcast();

        console2.log("Deployed to:", deployedAddress);
        console2.log("Verification - PERMIT2:", address(proxy.PERMIT2()));
        require(address(proxy.PERMIT2()) == permit2, "PERMIT2 mismatch");
    }

    function _computeCreate2Addr(
        bytes32 salt,
        bytes32 initCodeHash,
        address deployer
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
