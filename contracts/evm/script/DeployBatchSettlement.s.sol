// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {x402BatchSettlement} from "../src/x402BatchSettlement.sol";
import {Permit2DepositCollector} from "../src/periphery/Permit2DepositCollector.sol";
import {ERC3009DepositCollector} from "../src/periphery/ERC3009DepositCollector.sol";

/// @title DeployBatchSettlement
/// @notice Deployment script for x402BatchSettlement and deposit collectors using CREATE2
/// @dev Run with: forge script script/DeployBatchSettlement.s.sol --rpc-url $RPC_URL --broadcast --verify
///
///      Uses deterministic bytecode (cbor_metadata = false in foundry.toml) so
///      any machine compiling at the same git commit produces the same initCode
///      and therefore the same CREATE2 address.
contract DeployBatchSettlement is Script {
    /// @notice Canonical Permit2 address (Uniswap's official deployment)
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Arachnid's deterministic CREATE2 deployer (same on all EVM chains)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Vanity mined (`cargo run --release -- batch-stack`): batch ...0003, ERC3009 ...0004, Permit2 ...0005
    bytes32 constant BATCH_SALT = 0x000000000000000000000000000000000000000000000000e000000005be885c;
    bytes32 constant ERC3009_SALT = 0x0000000000000000000000000000000000000000000000001800000007a95284;
    bytes32 constant PERMIT2_COLLECTOR_SALT = 0x000000000000000000000000000000000000000000000000f800000001a5d4ff;

    function run() public {
        address permit2 = vm.envOr("PERMIT2_ADDRESS", CANONICAL_PERMIT2);

        console2.log("");
        console2.log("============================================================");
        console2.log("  x402BatchSettlement Deterministic Deployment (CREATE2)");
        console2.log("  Model: Dual-Authorizer Channel-Config + Deposit Collectors");
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

        address settlement = _expectedBatchAddress();
        _deploySettlement();
        _deployCollectors(permit2, settlement);

        console2.log("");
        console2.log("Deployment complete!");
        console2.log("");
    }

    /// @dev CREATE2 address for batch; must match collectors' constructor `settlement` argument.
    function _expectedBatchAddress() internal pure returns (address) {
        bytes memory initCode = type(x402BatchSettlement).creationCode;
        return _computeCreate2Addr(BATCH_SALT, keccak256(initCode), CREATE2_DEPLOYER);
    }

    function _deploySettlement() internal {
        console2.log("");
        console2.log("------------------------------------------------------------");
        console2.log("  Deploying x402BatchSettlement");
        console2.log("------------------------------------------------------------");

        _deployCreate2("x402BatchSettlement", BATCH_SALT, type(x402BatchSettlement).creationCode);
    }

    function _deployCollectors(address permit2, address settlement) internal {
        console2.log("");
        console2.log("------------------------------------------------------------");
        console2.log("  Deploying Deposit Collectors");
        console2.log("------------------------------------------------------------");
        console2.log("  Settlement (immutable arg):", settlement);

        _deployCreate2(
            "ERC3009DepositCollector",
            ERC3009_SALT,
            abi.encodePacked(type(ERC3009DepositCollector).creationCode, abi.encode(settlement))
        );

        _deployCreate2(
            "Permit2DepositCollector",
            PERMIT2_COLLECTOR_SALT,
            abi.encodePacked(type(Permit2DepositCollector).creationCode, abi.encode(settlement, permit2))
        );
    }

    function _deployCreate2(string memory name, bytes32 salt, bytes memory initCode) internal {
        bytes32 initCodeHash = keccak256(initCode);
        address expectedAddress = _computeCreate2Addr(salt, initCodeHash, CREATE2_DEPLOYER);

        console2.log("");
        console2.log(string.concat("  ", name));
        console2.log("  Salt:", vm.toString(salt));
        console2.log("  Expected address:", expectedAddress);

        if (expectedAddress.code.length > 0) {
            console2.log("  Already deployed, skipping");
            return;
        }

        vm.startBroadcast();

        if (block.chainid == 31_337 || block.chainid == 1337) {
            console2.log("  (Local network - using regular CREATE)");
            assembly {
                let addr := create(0, add(initCode, 0x20), mload(initCode))
                if iszero(addr) { revert(0, 0) }
            }
        } else {
            bytes memory deploymentData = abi.encodePacked(salt, initCode);
            (bool success,) = CREATE2_DEPLOYER.call(deploymentData);
            require(success, string.concat("CREATE2 deployment failed for ", name));
            require(expectedAddress.code.length > 0, string.concat("No bytecode at expected address for ", name));
        }

        vm.stopBroadcast();

        console2.log("  Deployed to:", expectedAddress);
    }

    function _computeCreate2Addr(
        bytes32 salt,
        bytes32 initCodeHash,
        address deployer
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
