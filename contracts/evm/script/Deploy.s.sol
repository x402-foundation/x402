// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402UptoERC3009Proxy} from "../src/x402UptoERC3009Proxy.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";

/**
 * @title DeployX402Proxies
 * @notice Deployment script for x402 Permit2 Proxy contracts using CREATE2
 * @dev Run with: forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
 *
 *      ## Deployment Strategy
 *
 *      **x402ExactPermit2Proxy** — Uses a pre-built initCode blob stored at
 *      `script/data/exact-proxy-initcode.hex`.  The original build included
 *      Solidity CBOR metadata (an IPFS hash that varies per build
 *      environment), so recompiling from source produces a *different*
 *      initCodeHash and therefore a different CREATE2 address.  By shipping
 *      the exact initCode that was used for the first deployment, anyone can
 *      deploy to the canonical address on any chain without needing the
 *      original build environment.
 *
 *      **x402UptoPermit2Proxy** — Built from source with deterministic
 *      bytecode (`cbor_metadata = false` in foundry.toml).  Any machine
 *      compiling at the same git commit will produce the same initCode and
 *      therefore the same CREATE2 address.
 *
 *      Both contracts use the canonical Permit2 address
 *      (0x000000000022D473030F116dDEE9F6B43aC78BA3) as a constructor
 *      argument. If Permit2 has not yet been deployed on the target chain,
 *      deploy it first.
 */
contract DeployX402Proxies is Script {
    /// @notice Canonical Permit2 address (Uniswap's official deployment)
    /// @dev Override via environment variable PERMIT2_ADDRESS for chains with different Permit2
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Arachnid's deterministic CREATE2 deployer (same on all EVM chains)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Runtime code hash of Arachnid's deterministic CREATE2 deployer.
    bytes32 constant CREATE2_DEPLOYER_CODE_HASH = 0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    /// @notice Salt for x402ExactPermit2Proxy deterministic deployment
    /// @dev Vanity mined for address 0x402085c248eea27d92e8b30b2c58ed07f9e20001
    bytes32 constant EXACT_SALT = 0x0000000000000000000000000000000000000000000000003000000007263b0e;

    /// @notice Salt for x402UptoPermit2Proxy deterministic deployment
    /// @dev Vanity mined for address 0x4020a4f3b7b90cca423b9fabcc0ce57c6c240002
    bytes32 constant UPTO_SALT = 0x000000000000000000000000000000000000000000000000b000000001db633d;

    /// @notice Salt for x402UptoERC3009Proxy deterministic deployment
    /// @dev Vanity mined for address 0x40203Fa50150e6ec970DE91F3330e82cDF640006
    bytes32 constant UPTO_ERC3009_SALT = 0x00000000000000000000000000000000000000000000000038000000202ec4a9;

    /// @notice Canonical x402UptoERC3009Proxy address.
    address constant UPTO_ERC3009_ADDRESS = 0x40203Fa50150e6ec970DE91F3330e82cDF640006;

    /// @notice Expected x402UptoERC3009Proxy creation bytecode hash.
    bytes32 constant UPTO_ERC3009_INIT_CODE_HASH = 0xf58e989274e849865b38511b1420136fc8ee69e89ddf67bc95290fb91bf382a3;

    /// @notice Expected x402UptoERC3009Proxy runtime bytecode hash.
    bytes32 constant UPTO_ERC3009_RUNTIME_CODE_HASH =
        0xf73db9eae81b2748946c6fe2530da2ba8f933d1a08357bd43760c7d9b102feb9;

    /// @notice Expected initCodeHash for x402ExactPermit2Proxy (pre-built, includes CBOR metadata)
    bytes32 constant EXACT_INIT_CODE_HASH = 0xe774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c;

    function run() public {
        address permit2 = vm.envOr("PERMIT2_ADDRESS", CANONICAL_PERMIT2);

        console2.log("");
        console2.log("============================================================");
        console2.log("  x402 Permit2 Proxies Deterministic Deployment (CREATE2)");
        console2.log("============================================================");
        console2.log("");

        console2.log("Network: chainId", block.chainid);
        console2.log("Permit2:", permit2);
        console2.log("CREATE2 Deployer:", CREATE2_DEPLOYER);
        console2.log("");

        if (block.chainid != 31_337 && block.chainid != 1337) {
            require(permit2.code.length > 0, "Permit2 not found on this network");
            console2.log("Permit2 verified");

            _requireCreate2Deployer();
            console2.log("CREATE2 deployer verified");
        }

        _deployExact(permit2);
        _deployUpto(permit2);
        _deployUptoERC3009();

        console2.log("");
        console2.log("All deployments complete!");
        console2.log("");
    }

    /// @notice Deploys only x402UptoPermit2Proxy.
    function runUpto() public {
        address permit2 = vm.envOr("PERMIT2_ADDRESS", CANONICAL_PERMIT2);

        if (block.chainid != 31_337 && block.chainid != 1337) {
            require(permit2.code.length > 0, "Permit2 not found on this network");
            console2.log("Permit2 verified");

            _requireCreate2Deployer();
            console2.log("CREATE2 deployer verified");
        }

        _deployUpto(permit2);
    }

    /// @notice Deploys only x402UptoERC3009Proxy.
    function runUptoERC3009() public {
        if (block.chainid != 31_337 && block.chainid != 1337) {
            _requireCreate2Deployer();
            console2.log("CREATE2 deployer verified");
        }

        _deployUptoERC3009();
    }

    function _deployExact(
        address permit2
    ) internal {
        console2.log("");
        console2.log("------------------------------------------------------------");
        console2.log("  Deploying x402ExactPermit2Proxy");
        console2.log("------------------------------------------------------------");

        bytes memory initCode;

        if (block.chainid == 31_337 || block.chainid == 1337) {
            initCode = abi.encodePacked(type(x402ExactPermit2Proxy).creationCode, abi.encode(permit2));
        } else {
            initCode = vm.parseBytes(vm.readFile("script/data/exact-proxy-initcode.hex"));
            bytes32 actualHash = keccak256(initCode);
            require(actualHash == EXACT_INIT_CODE_HASH, "Exact initCode hash mismatch - hex file may be corrupted");
        }

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

    function _deployUptoERC3009() internal {
        console2.log("");
        console2.log("------------------------------------------------------------");
        console2.log("  Deploying x402UptoERC3009Proxy");
        console2.log("------------------------------------------------------------");

        bytes memory initCode = type(x402UptoERC3009Proxy).creationCode;
        bytes32 initCodeHash = keccak256(initCode);
        address expectedAddress = _computeCreate2Addr(UPTO_ERC3009_SALT, initCodeHash, CREATE2_DEPLOYER);
        require(initCodeHash == UPTO_ERC3009_INIT_CODE_HASH, "Upto ERC3009 init code hash mismatch");
        require(expectedAddress == UPTO_ERC3009_ADDRESS, "Upto ERC3009 address mismatch");

        console2.log("Salt:", vm.toString(UPTO_ERC3009_SALT));
        console2.log("Expected address:", expectedAddress);
        console2.log("Init code hash:", vm.toString(initCodeHash));

        if (expectedAddress.code.length > 0) {
            require(expectedAddress.codehash == UPTO_ERC3009_RUNTIME_CODE_HASH, "Upto ERC3009 runtime hash mismatch");
            console2.log("Contract already deployed at", expectedAddress);
            return;
        }

        vm.startBroadcast();

        address deployedAddress;
        if (block.chainid == 31_337 || block.chainid == 1337) {
            console2.log("(Using regular deployment for local network)");
            deployedAddress = address(new x402UptoERC3009Proxy());
        } else {
            bytes memory deploymentData = abi.encodePacked(UPTO_ERC3009_SALT, initCode);
            (bool success,) = CREATE2_DEPLOYER.call(deploymentData);
            require(success, "CREATE2 deployment failed for Upto ERC3009");
            deployedAddress = expectedAddress;
            require(deployedAddress.code.length > 0, "No bytecode at expected address");
        }

        vm.stopBroadcast();

        require(deployedAddress.codehash == UPTO_ERC3009_RUNTIME_CODE_HASH, "Upto ERC3009 runtime hash mismatch");
        console2.log("Deployed to:", deployedAddress);
    }

    function _requireCreate2Deployer() internal view {
        require(CREATE2_DEPLOYER.codehash == CREATE2_DEPLOYER_CODE_HASH, "CREATE2 deployer code hash mismatch");
    }

    function _computeCreate2Addr(
        bytes32 salt,
        bytes32 initCodeHash,
        address deployer
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
