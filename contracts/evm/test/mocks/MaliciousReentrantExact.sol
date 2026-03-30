// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {x402ExactPermit2Proxy} from "../../src/x402ExactPermit2Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MaliciousReentrantExact is ISignatureTransfer {
    x402ExactPermit2Proxy public target;
    bool public attemptReentry;

    ISignatureTransfer.PermitTransferFrom public storedPermit;
    address public storedOwner;
    x402ExactPermit2Proxy.Witness public storedWitness;
    bytes public storedSignature;

    mapping(address => mapping(uint256 => uint256)) public nonceBitmapStorage;

    function setTarget(
        address _target
    ) external {
        target = x402ExactPermit2Proxy(_target);
    }

    function setAttemptReentry(
        bool _attempt
    ) external {
        attemptReentry = _attempt;
    }

    function setAttackParams(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        x402ExactPermit2Proxy.Witness calldata witness,
        bytes calldata signature
    ) external {
        storedPermit = permit;
        storedOwner = owner;
        storedWitness = witness;
        storedSignature = signature;
    }

    function nonceBitmap(address owner, uint256 wordPos) external view override returns (uint256) {
        return nonceBitmapStorage[owner][wordPos];
    }

    function permitTransferFrom(
        PermitTransferFrom memory,
        SignatureTransferDetails calldata,
        address,
        bytes calldata
    ) external pure override {
        revert("Use permitWitnessTransferFrom");
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32,
        string calldata,
        bytes calldata
    ) external override {
        uint256 wordPos = permit.nonce >> 8;
        uint256 bitPos = permit.nonce & 0xff;
        nonceBitmapStorage[owner][wordPos] |= (1 << bitPos);

        if (attemptReentry && address(target) != address(0)) {
            target.settle(storedPermit, storedOwner, storedWitness, storedSignature);
        }

        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }
}
