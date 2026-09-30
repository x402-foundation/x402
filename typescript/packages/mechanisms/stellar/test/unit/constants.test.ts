import { describe, it, expect } from "vitest";
import {
  STELLAR_ASSET_ADDRESS_REGEX,
  STELLAR_DESTINATION_ADDRESS_REGEX,
} from "../../src/constants";

describe("STELLAR_DESTINATION_ADDRESS_REGEX", () => {
  it("should match valid G-accounts (56 characters)", () => {
    const validGAccounts = [
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      "G" + "A".repeat(27) + "2".repeat(28),
    ];

    validGAccounts.forEach(address => {
      expect(STELLAR_DESTINATION_ADDRESS_REGEX.test(address)).toBe(true);
    });
  });

  it("should match valid C-accounts (56 characters)", () => {
    const validCAccounts = [
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      "C" + "B".repeat(27) + "2".repeat(28),
    ];

    validCAccounts.forEach(address => {
      expect(STELLAR_DESTINATION_ADDRESS_REGEX.test(address)).toBe(true);
    });
  });

  it("should match valid M-accounts (69 characters)", () => {
    const validMAccounts = [
      "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KAAAAAAAAAAAAFKBA",
      "M" + "C".repeat(34) + "3".repeat(34),
    ];

    validMAccounts.forEach(address => {
      expect(STELLAR_DESTINATION_ADDRESS_REGEX.test(address)).toBe(true);
    });
  });

  it("should reject invalid Stellar addresses", () => {
    const invalidAddresses = [
      "", // Empty string
      "G", // Just prefix (too short)
      "C", // Just prefix (too short)
      "M", // Just prefix (too short)
      "G" + "A".repeat(56), // G-account too long (57 chars)
      "GA" + "2".repeat(53), // G-account too short (55 chars)
      "C" + "B".repeat(56), // C-account too long (57 chars)
      "CA" + "2".repeat(53), // C-account too short (55 chars)
      "M" + "C".repeat(69), // M-account too long (70 chars)
      "MA" + "3".repeat(66), // M-account too short (68 chars)
      "XA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // Invalid prefix 'X'
      "GE5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // Invalid second character
      "gA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // Lowercase prefix
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN ", // Space character
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN-", // Hyphen character
      "0xGA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // EVM-style prefix
      "ME5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KAAAAAAAAAAAAFKBA", // invalid second character in M-account
    ];

    invalidAddresses.forEach(address => {
      expect(STELLAR_DESTINATION_ADDRESS_REGEX.test(address)).toBe(false);
    });
  });
});

describe("STELLAR_ASSET_ADDRESS_REGEX", () => {
  it("should match valid C-accounts (56 characters)", () => {
    const validCAccounts = [
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      "C" + "B".repeat(27) + "2".repeat(28),
    ];

    validCAccounts.forEach(address => {
      expect(STELLAR_ASSET_ADDRESS_REGEX.test(address)).toBe(true);
    });
  });

  it("should reject invalid Stellar addresses", () => {
    const invalidAddresses = [
      "", // Empty string
      "C", // Just prefix (too short)
      "C" + "B".repeat(56), // C-account too long (57 chars)
      "CA" + "2".repeat(53), // C-account too short (55 chars)
      "XA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // Invalid prefix 'X'
      "CE5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // Invalid second character
      "cA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // Lowercase prefix
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // G-account
      "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KAAAAAAAAAAAAFKBA", // M-account
      "0xGA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // EVM-style prefix
    ];

    invalidAddresses.forEach(address => {
      expect(STELLAR_ASSET_ADDRESS_REGEX.test(address)).toBe(false);
    });
  });
});
