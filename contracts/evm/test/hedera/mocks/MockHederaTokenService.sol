// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 whose balances can additionally be moved by the mocked HTS system contract at `0x167`,
///         emulating an HTS token's ERC-20 facade.
contract MockHtsToken is ERC20 {
    address public constant HTS = address(0x167);

    constructor() ERC20("Mock HTS USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Only the HTS system contract may move balances without an ERC-20 approval.
    function htsTransfer(address from, address to, uint256 amount) external {
        require(msg.sender == HTS, "MOCK_HTS_ONLY");
        _transfer(from, to, amount);
    }
}

/// @notice Test double for the Hedera Token Service system contract, etched at `address(0x167)`.
///
/// @dev Tracks HTS allowances (granted natively in production via `AccountAllowanceApproveTransaction`)
///      and token associations. `transferFrom` consumes the allowance of `msg.sender` (the spender).
contract MockHederaTokenService {
    int64 public constant SUCCESS = 22;
    int64 public constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;
    int64 public constant SPENDER_DOES_NOT_HAVE_ALLOWANCE = 292;
    int64 public constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;

    mapping(address token => mapping(address owner => mapping(address spender => uint256))) public allowances;
    mapping(address account => mapping(address token => bool)) public associated;
    int64 public forcedAssociateResponse;
    int64 public forcedTransferResponse;

    /// @dev Emulates the payer's native allowance approval.
    function setAllowance(address token, address owner, address spender, uint256 amount) external {
        allowances[token][owner][spender] = amount;
    }

    function setAssociated(address account, address token, bool value) external {
        associated[account][token] = value;
    }

    function forceAssociateResponse(int64 code) external {
        forcedAssociateResponse = code;
    }

    function forceTransferResponse(int64 code) external {
        forcedTransferResponse = code;
    }

    function associateToken(address account, address token) external returns (int64) {
        require(account == msg.sender, "MOCK_HTS_ASSOCIATE_SELF_ONLY");
        if (forcedAssociateResponse != 0) return forcedAssociateResponse;
        if (associated[account][token]) return TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT;
        associated[account][token] = true;
        return SUCCESS;
    }

    function transferFrom(address token, address from, address to, uint256 amount) external returns (int64) {
        if (forcedTransferResponse != 0) return forcedTransferResponse;
        if (!associated[to][token]) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        uint256 allowed = allowances[token][from][msg.sender];
        if (allowed < amount) return SPENDER_DOES_NOT_HAVE_ALLOWANCE;
        allowances[token][from][msg.sender] = allowed - amount;
        MockHtsToken(token).htsTransfer(from, to, amount);
        return SUCCESS;
    }

    function allowance(address token, address owner, address spender) external view returns (int64, uint256) {
        return (SUCCESS, allowances[token][owner][spender]);
    }
}
