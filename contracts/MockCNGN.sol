// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockCNGN
/// @author Lawal Ridwan
/// @notice Test/demo stand-in for cNGN, the naira-backed stablecoin. 6 decimals, 1 token = ₦1.
/// @dev TESTNET ONLY. The owner can mint freely. Never use this in production: point
///      NairaAidCampaigns at the real cNGN contract instead.
contract MockCNGN is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Mock Compliant Naira", "cNGN") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test tokens. Owner only.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
