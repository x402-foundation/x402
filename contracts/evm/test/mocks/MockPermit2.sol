// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPermit2 is ISignatureTransfer {
    mapping(address => mapping(uint256 => uint256)) public nonceBitmapStorage;
    bool public shouldActuallyTransfer;

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

        if (shouldActuallyTransfer) {
            IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
        }
    }

    function setShouldActuallyTransfer(
        bool _should
    ) external {
        shouldActuallyTransfer = _should;
    }
}
