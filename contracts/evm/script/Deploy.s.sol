// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";

/**
 * @title DeployX402Proxies
 * @notice Deployment script for x402 Permit2 Proxy contracts using CREATE2
 * @dev Run with: forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
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
    uint256 constant ARC_TESTNET_CHAIN_ID = 5_042_002;

    /// @notice Canonical Permit2 address (Uniswap's official deployment)
    /// @dev Override via environment variable PERMIT2_ADDRESS for chains with different Permit2
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Arachnid's deterministic CREATE2 deployer (same on all EVM chains)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Salt for x402ExactPermit2Proxy deterministic deployment
    /// @dev Vanity mined for address 0x402085c248eea27d92e8b30b2c58ed07f9e20001
    bytes32 constant EXACT_SALT = 0x0000000000000000000000000000000000000000000000003000000007263b0e;

    /// @notice Salt for x402UptoPermit2Proxy deterministic deployment
    /// @dev Vanity mined for address 0x402015c795ecb48a360bdc6e35a2eaeb313a0002
    bytes32 constant UPTO_SALT = 0x0000000000000000000000000000000000000000000000000800000007e2e4de;

    /// @notice Expected initCodeHash for x402ExactPermit2Proxy (pre-built, includes CBOR metadata)
    bytes32 constant EXACT_INIT_CODE_HASH = 0xe774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c;

    address constant ARC_TESTNET_UPTO_ADDRESS = 0x402015c795ecb48A360bDC6e35a2EaEb313a0002;
    bytes32 constant ARC_TESTNET_UPTO_INIT_CODE_HASH =
        0x01575bfc9cacbf6463db62ee8867594b1657139c8493a712ef6bcefa848a20b7;
    bytes32 constant ARC_TESTNET_UPTO_RUNTIME_CODE_HASH =
        0xc858e50b1c4c2207d032578532415db2db50ed0ad509b67b8ac7200d771c70f3;
    bytes32 constant ARC_TESTNET_PERMIT2_RUNTIME_CODE_HASH =
        0x53681d3cf8f702f849c1504b491049c3d0a282e4595d9b297c410dcf36f0908e;
    bytes32 constant ARC_TESTNET_PERMIT2_DOMAIN_SEPARATOR =
        0xe59c8d3fa907f1186bfa334839eb895f53f88b07e4cf5aafaef4af163d83ce93;
    bytes32 constant CREATE2_DEPLOYER_RUNTIME_CODE_HASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

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

            require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer not found on this network");
            console2.log("CREATE2 deployer verified");
        }

        _deployExact(permit2);
        _deployUpto(permit2);

        console2.log("");
        console2.log("All deployments complete!");
        console2.log("");
    }

    /// @notice Deploys only x402UptoPermit2Proxy using Arc testnet's canonical dependencies.
    function runUptoArcTestnet() public {
        bytes memory deploymentData = prepareUptoArcTestnet();

        vm.startBroadcast();
        (bool success, bytes memory returnData) = CREATE2_DEPLOYER.call(deploymentData);
        vm.stopBroadcast();

        require(success, "CREATE2 deployment failed for Upto");
        require(returnData.length == 20, "Unexpected CREATE2 deployer response");

        address returnedAddress;
        assembly {
            returnedAddress := shr(96, mload(add(returnData, 32)))
        }
        require(returnedAddress == ARC_TESTNET_UPTO_ADDRESS, "CREATE2 deployer returned wrong address");

        validateUptoArcTestnet();
        console2.log("Deployed x402UptoPermit2Proxy to:", ARC_TESTNET_UPTO_ADDRESS);
    }

    /// @notice Validates Arc testnet dependencies and returns the exact factory calldata.
    function prepareUptoArcTestnet() public view returns (bytes memory deploymentData) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Arc testnet chain ID mismatch");
        _validateArcTestnetDependencies();
        deploymentData = uptoArcTestnetDeploymentData();
        require(ARC_TESTNET_UPTO_ADDRESS.code.length == 0, "Upto target already occupied");
    }

    /// @notice Validates the deployed Arc testnet proxy against the approved artifact.
    function validateUptoArcTestnet() public view {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Arc testnet chain ID mismatch");
        _validateArcTestnetDependencies();
        uptoArcTestnetDeploymentData();

        require(
            ARC_TESTNET_UPTO_ADDRESS.codehash == ARC_TESTNET_UPTO_RUNTIME_CODE_HASH, "Upto runtime code hash mismatch"
        );
        require(
            address(x402UptoPermit2Proxy(ARC_TESTNET_UPTO_ADDRESS).PERMIT2()) == CANONICAL_PERMIT2,
            "Upto PERMIT2 mismatch"
        );
    }

    /// @notice Returns factory calldata only when the locally compiled Upto artifact is canonical.
    function uptoArcTestnetDeploymentData() public pure returns (bytes memory deploymentData) {
        bytes memory initCode = abi.encodePacked(type(x402UptoPermit2Proxy).creationCode, abi.encode(CANONICAL_PERMIT2));
        bytes32 initCodeHash = keccak256(initCode);
        require(initCodeHash == ARC_TESTNET_UPTO_INIT_CODE_HASH, "Upto init code hash mismatch");

        address expectedAddress = _computeCreate2Addr(UPTO_SALT, initCodeHash, CREATE2_DEPLOYER);
        require(expectedAddress == ARC_TESTNET_UPTO_ADDRESS, "Upto CREATE2 address mismatch");

        deploymentData = abi.encodePacked(UPTO_SALT, initCode);
    }

    function _validateArcTestnetDependencies() internal view {
        require(CREATE2_DEPLOYER.codehash == CREATE2_DEPLOYER_RUNTIME_CODE_HASH, "CREATE2 deployer code hash mismatch");
        require(
            CANONICAL_PERMIT2.codehash == ARC_TESTNET_PERMIT2_RUNTIME_CODE_HASH, "Permit2 runtime code hash mismatch"
        );

        (bool success, bytes memory returnData) =
            CANONICAL_PERMIT2.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        require(success && returnData.length == 32, "Permit2 DOMAIN_SEPARATOR call failed");
        require(
            abi.decode(returnData, (bytes32)) == ARC_TESTNET_PERMIT2_DOMAIN_SEPARATOR,
            "Permit2 DOMAIN_SEPARATOR mismatch"
        );
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

    function _computeCreate2Addr(
        bytes32 salt,
        bytes32 initCodeHash,
        address deployer
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
