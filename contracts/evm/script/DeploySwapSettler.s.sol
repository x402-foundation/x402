// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {x402SwapSettler} from "../src/x402SwapSettler.sol";

/**
 * @title DeploySwapSettler
 * @notice Deployment script for x402SwapSettler using CREATE2
 * @dev Run with:
 *        SETTLER_OWNER=0x... forge script script/DeploySwapSettler.s.sol \
 *          --rpc-url $RPC_URL --broadcast --verify
 *
 *      Built from source with deterministic bytecode (`cbor_metadata = false` in
 *      foundry.toml): any machine compiling at the same git commit with the same
 *      constructor arguments produces the same initCode, and therefore the same CREATE2
 *      address on every chain.
 *
 *      Optional post-deploy configuration (requires the broadcaster to be the owner):
 *        FACILITATOR_ADDRESS — authorized settlement caller (setFacilitator)
 *        SWAP_TARGET_ADDRESS — whitelisted swap router/aggregator (setSwapTarget)
 */
contract DeploySwapSettler is Script {
    /// @notice Canonical Permit2 address (Uniswap's official deployment)
    /// @dev Override via environment variable PERMIT2_ADDRESS for chains with different Permit2
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Arachnid's deterministic CREATE2 deployer (same on all EVM chains)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Default salt for deterministic deployment (override via SWAP_SETTLER_SALT)
    bytes32 constant DEFAULT_SALT = keccak256("x402SwapSettler.v1");

    function run() public {
        address permit2 = vm.envOr("PERMIT2_ADDRESS", CANONICAL_PERMIT2);
        address owner = vm.envAddress("SETTLER_OWNER");
        bytes32 salt = vm.envOr("SWAP_SETTLER_SALT", DEFAULT_SALT);

        console2.log("");
        console2.log("============================================================");
        console2.log("  x402SwapSettler Deterministic Deployment (CREATE2)");
        console2.log("============================================================");
        console2.log("");
        console2.log("Network: chainId", block.chainid);
        console2.log("Permit2:", permit2);
        console2.log("Owner:", owner);
        console2.log("CREATE2 Deployer:", CREATE2_DEPLOYER);
        console2.log("");

        if (block.chainid != 31_337 && block.chainid != 1337) {
            require(permit2.code.length > 0, "Permit2 not found on this network");
            console2.log("Permit2 verified");

            require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer not found on this network");
            console2.log("CREATE2 deployer verified");
        }

        bytes memory initCode = abi.encodePacked(type(x402SwapSettler).creationCode, abi.encode(permit2, owner));
        bytes32 initCodeHash = keccak256(initCode);
        address expectedAddress = _computeCreate2Addr(salt, initCodeHash, CREATE2_DEPLOYER);

        console2.log("Salt:", vm.toString(salt));
        console2.log("Expected address:", expectedAddress);
        console2.log("Init code hash:", vm.toString(initCodeHash));

        x402SwapSettler settler;

        if (expectedAddress.code.length > 0) {
            console2.log("Contract already deployed at", expectedAddress);
            settler = x402SwapSettler(expectedAddress);
        } else {
            vm.startBroadcast();

            if (block.chainid == 31_337 || block.chainid == 1337) {
                console2.log("(Using regular deployment for local network)");
                settler = new x402SwapSettler(permit2, owner);
            } else {
                bytes memory deploymentData = abi.encodePacked(salt, initCode);
                (bool success,) = CREATE2_DEPLOYER.call(deploymentData);
                require(success, "CREATE2 deployment failed for x402SwapSettler");
                require(expectedAddress.code.length > 0, "No bytecode at expected address");
                settler = x402SwapSettler(expectedAddress);
            }

            vm.stopBroadcast();
        }

        console2.log("Deployed to:", address(settler));
        console2.log("Verification - PERMIT2:", address(settler.PERMIT2()));
        console2.log("Verification - owner:", settler.owner());
        require(address(settler.PERMIT2()) == permit2, "PERMIT2 mismatch");
        require(settler.owner() == owner, "owner mismatch");

        _configure(settler);

        console2.log("");
        console2.log("Deployment complete!");
        console2.log("");
    }

    function _configure(
        x402SwapSettler settler
    ) internal {
        address facilitator = vm.envOr("FACILITATOR_ADDRESS", address(0));
        address swapTarget = vm.envOr("SWAP_TARGET_ADDRESS", address(0));
        if (facilitator == address(0) && swapTarget == address(0)) return;

        vm.startBroadcast();
        if (facilitator != address(0) && !settler.facilitators(facilitator)) {
            settler.setFacilitator(facilitator, true);
            console2.log("Facilitator authorized:", facilitator);
        }
        if (swapTarget != address(0) && !settler.swapTargets(swapTarget)) {
            settler.setSwapTarget(swapTarget, true);
            console2.log("Swap target whitelisted:", swapTarget);
        }
        vm.stopBroadcast();
    }

    function _computeCreate2Addr(
        bytes32 salt,
        bytes32 initCodeHash,
        address deployer
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
