// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";
import {x402BatchSettlement} from "../src/x402BatchSettlement.sol";
import {ERC3009DepositCollector} from "../src/periphery/ERC3009DepositCollector.sol";
import {Permit2DepositCollector} from "../src/periphery/Permit2DepositCollector.sol";

/**
 * @title ComputeAddress
 * @notice Compute the deterministic CREATE2 addresses for x402 Permit2 Proxies
 *
 * @dev x402ExactPermit2Proxy uses a pre-built initCode (script/data/exact-proxy-initcode.hex)
 *      because the original build included non-deterministic CBOR metadata.
 *
 *      x402UptoPermit2Proxy uses compiler-derived creationCode, which is deterministic
 *      thanks to cbor_metadata = false in foundry.toml.
 *
 * @dev Run with default salts:
 *      forge script script/ComputeAddress.s.sol
 *
 * @dev Run with custom salts (exact + upto):
 *      forge script script/ComputeAddress.s.sol --sig "computeAddresses(bytes32,bytes32)" <EXACT_SALT> <UPTO_SALT>
 *
 * @dev Run BatchSettlement only with custom salt:
 *      forge script script/ComputeAddress.s.sol --sig "computeBatchAddress(bytes32)" <BATCH_SALT>
 *
 * @dev Batch + deposit collectors (salts must match DeployBatchSettlement.s.sol):
 *      forge script script/ComputeAddress.s.sol --sig "computeBatchStack(bytes32,bytes32,bytes32,address)" <BATCH_SALT> <ERC3009_SALT> <PERMIT2_COL_SALT> <PERMIT2>
 */
contract ComputeAddress is Script {
    /// @notice Arachnid's deterministic CREATE2 deployer
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Canonical Permit2 address (same on all EVM chains)
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Default salt for x402ExactPermit2Proxy
    /// @dev Vanity mined for address 0x402085c248eea27d92e8b30b2c58ed07f9e20001
    bytes32 constant DEFAULT_EXACT_SALT = 0x0000000000000000000000000000000000000000000000003000000007263b0e;

    /// @notice Default salt for x402UptoPermit2Proxy
    /// @dev Vanity mined for address 0x4020a4f3b7b90cca423b9fabcc0ce57c6c240002
    bytes32 constant DEFAULT_UPTO_SALT = 0x000000000000000000000000000000000000000000000000b000000001db633d;

    /// @notice Expected initCodeHash for x402ExactPermit2Proxy (pre-built, includes CBOR metadata)
    bytes32 constant EXACT_INIT_CODE_HASH = 0xe774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c;

    /**
     * @notice Computes the CREATE2 addresses using the default salts
     */
    function run() public view {
        computeAddresses(DEFAULT_EXACT_SALT, DEFAULT_UPTO_SALT);
    }

    /**
     * @notice Computes the CREATE2 addresses for both x402 Permit2 Proxies
     * @param exactSalt The salt to use for x402ExactPermit2Proxy
     * @param uptoSalt The salt to use for x402UptoPermit2Proxy
     */
    function computeAddresses(bytes32 exactSalt, bytes32 uptoSalt) public view {
        console2.log("");
        console2.log("============================================================");
        console2.log("  x402 Permit2 Proxy Address Computation");
        console2.log("============================================================");
        console2.log("");

        console2.log("Configuration:");
        console2.log("  CREATE2 Deployer:    ", CREATE2_DEPLOYER);
        console2.log("  Permit2 (ctor arg):  ", CANONICAL_PERMIT2);
        console2.log("");

        // x402ExactPermit2Proxy — uses pre-built initCode from hex file
        {
            bytes memory initCode = vm.parseBytes(vm.readFile("script/data/exact-proxy-initcode.hex"));
            bytes32 initCodeHash = keccak256(initCode);

            require(initCodeHash == EXACT_INIT_CODE_HASH, "Exact initCode hash mismatch - hex file may be corrupted");

            address expectedAddress = _computeCreate2Addr(exactSalt, initCodeHash, CREATE2_DEPLOYER);

            console2.log("------------------------------------------------------------");
            console2.log("  x402ExactPermit2Proxy (pre-built initCode)");
            console2.log("------------------------------------------------------------");
            console2.log("  Salt:           ", vm.toString(exactSalt));
            console2.log("  Init Code Hash: ", vm.toString(initCodeHash));
            console2.log("  Address:        ", expectedAddress);

            if (block.chainid != 0 && expectedAddress.code.length > 0) {
                console2.log("  Status: DEPLOYED");
            } else {
                console2.log("  Status: NOT DEPLOYED");
            }
            console2.log("");
        }

        // x402UptoPermit2Proxy — uses compiler-derived creationCode (deterministic)
        {
            bytes memory initCode =
                abi.encodePacked(type(x402UptoPermit2Proxy).creationCode, abi.encode(CANONICAL_PERMIT2));
            bytes32 initCodeHash = keccak256(initCode);
            address expectedAddress = _computeCreate2Addr(uptoSalt, initCodeHash, CREATE2_DEPLOYER);

            console2.log("------------------------------------------------------------");
            console2.log("  x402UptoPermit2Proxy (deterministic build)");
            console2.log("------------------------------------------------------------");
            console2.log("  Salt:           ", vm.toString(uptoSalt));
            console2.log("  Init Code Hash: ", vm.toString(initCodeHash));
            console2.log("  Address:        ", expectedAddress);

            if (block.chainid != 0 && expectedAddress.code.length > 0) {
                console2.log("  Status: DEPLOYED");
            } else {
                console2.log("  Status: NOT DEPLOYED");
            }
            console2.log("");
        }
    }

    /**
     * @notice Computes the CREATE2 address for x402BatchSettlement
     * @param batchSalt The salt to use for x402BatchSettlement
     */
    function computeBatchAddress(
        bytes32 batchSalt
    ) public view {
        console2.log("");
        console2.log("============================================================");
        console2.log("  x402BatchSettlement Address Computation");
        console2.log("============================================================");
        console2.log("");

        console2.log("Configuration:");
        console2.log("  CREATE2 Deployer:    ", CREATE2_DEPLOYER);
        console2.log("");

        bytes memory initCode = type(x402BatchSettlement).creationCode;
        bytes32 initCodeHash = keccak256(initCode);
        address expectedAddress = _computeCreate2Addr(batchSalt, initCodeHash, CREATE2_DEPLOYER);

        console2.log("------------------------------------------------------------");
        console2.log("  x402BatchSettlement (deterministic build, no ctor args)");
        console2.log("------------------------------------------------------------");
        console2.log("  Salt:           ", vm.toString(batchSalt));
        console2.log("  Init Code Hash: ", vm.toString(initCodeHash));
        console2.log("  Address:        ", expectedAddress);

        if (block.chainid != 0 && expectedAddress.code.length > 0) {
            console2.log("  Status: DEPLOYED");
        } else {
            console2.log("  Status: NOT DEPLOYED");
        }
        console2.log("");
    }

    /**
     * @notice CREATE2 addresses for batch settlement + deposit collectors (matches DeployBatchSettlement.s.sol).
     * @param batchSalt CREATE2 salt for x402BatchSettlement
     * @param erc3009Salt CREATE2 salt for ERC3009DepositCollector
     * @param permit2CollectorSalt CREATE2 salt for Permit2DepositCollector
     * @param permit2 Permit2 address encoded in Permit2DepositCollector constructor (second arg)
     */
    function computeBatchStack(
        bytes32 batchSalt,
        bytes32 erc3009Salt,
        bytes32 permit2CollectorSalt,
        address permit2
    ) public view {
        console2.log("");
        console2.log("============================================================");
        console2.log("  Batch settlement + deposit collectors (CREATE2)");
        console2.log("============================================================");
        console2.log("");
        console2.log("  CREATE2 Deployer: ", CREATE2_DEPLOYER);
        console2.log("  Permit2 (collector ctor): ", permit2);
        console2.log("");

        bytes memory batchInit = type(x402BatchSettlement).creationCode;
        bytes32 batchInitHash = keccak256(batchInit);
        address settlement = _computeCreate2Addr(batchSalt, batchInitHash, CREATE2_DEPLOYER);

        console2.log("------------------------------------------------------------");
        console2.log("  x402BatchSettlement");
        console2.log("------------------------------------------------------------");
        console2.log("  Salt:           ", vm.toString(batchSalt));
        console2.log("  Init Code Hash: ", vm.toString(batchInitHash));
        console2.log("  Address:        ", settlement);
        _logDeployed(settlement);
        console2.log("");

        bytes memory ercInit = abi.encodePacked(type(ERC3009DepositCollector).creationCode, abi.encode(settlement));
        bytes32 ercHash = keccak256(ercInit);
        address ercAddr = _computeCreate2Addr(erc3009Salt, ercHash, CREATE2_DEPLOYER);

        console2.log("------------------------------------------------------------");
        console2.log("  ERC3009DepositCollector");
        console2.log("------------------------------------------------------------");
        console2.log("  Salt:           ", vm.toString(erc3009Salt));
        console2.log("  Init Code Hash: ", vm.toString(ercHash));
        console2.log("  Address:        ", ercAddr);
        _logDeployed(ercAddr);
        console2.log("");

        bytes memory pInit =
            abi.encodePacked(type(Permit2DepositCollector).creationCode, abi.encode(settlement, permit2));
        bytes32 pHash = keccak256(pInit);
        address pAddr = _computeCreate2Addr(permit2CollectorSalt, pHash, CREATE2_DEPLOYER);

        console2.log("------------------------------------------------------------");
        console2.log("  Permit2DepositCollector");
        console2.log("------------------------------------------------------------");
        console2.log("  Salt:           ", vm.toString(permit2CollectorSalt));
        console2.log("  Init Code Hash: ", vm.toString(pHash));
        console2.log("  Address:        ", pAddr);
        _logDeployed(pAddr);
        console2.log("");
    }

    function _logDeployed(
        address a
    ) private view {
        if (block.chainid != 0 && a.code.length > 0) {
            console2.log("  Status: DEPLOYED");
        } else {
            console2.log("  Status: NOT DEPLOYED");
        }
    }

    function _computeCreate2Addr(
        bytes32 salt,
        bytes32 initCodeHash,
        address deployer
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
