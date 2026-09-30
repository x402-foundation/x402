/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getRpcClient,
  getRpcSubscriptions,
  createDevnetRpcClient,
  createMainnetRpcClient,
} from "./rpc";
import * as solanaKit from "@solana/kit";

// Mock the Solana Kit functions
vi.mock("@solana/kit", () => ({
  createSolanaRpc: vi.fn(),
  createSolanaRpcSubscriptions: vi.fn(),
  devnet: vi.fn((url?: string) => url || "https://api.devnet.solana.com"),
  mainnet: vi.fn((url?: string) => url || "https://api.mainnet-beta.solana.com"),
}));

describe("RPC Helper Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createDevnetRpcClient", () => {
    it("should create devnet RPC client with default URL when no URL provided", () => {
      const mockRpcClient = { mock: "devnet-client" };
      vi.mocked(solanaKit.createSolanaRpc).mockReturnValue(mockRpcClient as any);

      const result = createDevnetRpcClient();

      expect(solanaKit.devnet).toHaveBeenCalledWith("https://api.devnet.solana.com");
      expect(solanaKit.createSolanaRpc).toHaveBeenCalledWith("https://api.devnet.solana.com");
      expect(result).toBe(mockRpcClient);
    });

    it("should create devnet RPC client with custom URL when provided", () => {
      const customUrl = "http://localhost:8899";
      const mockRpcClient = { mock: "devnet-client-custom" };
      vi.mocked(solanaKit.createSolanaRpc).mockReturnValue(mockRpcClient as any);

      const result = createDevnetRpcClient(customUrl);

      expect(solanaKit.devnet).toHaveBeenCalledWith(customUrl);
      expect(solanaKit.createSolanaRpc).toHaveBeenCalledWith(customUrl);
      expect(result).toBe(mockRpcClient);
    });
  });

  describe("createMainnetRpcClient", () => {
    it("should create mainnet RPC client with default URL when no URL provided", () => {
      const mockRpcClient = { mock: "mainnet-client" };
      vi.mocked(solanaKit.createSolanaRpc).mockReturnValue(mockRpcClient as any);

      const result = createMainnetRpcClient();

      expect(solanaKit.mainnet).toHaveBeenCalledWith("https://api.mainnet-beta.solana.com");
      expect(solanaKit.createSolanaRpc).toHaveBeenCalledWith("https://api.mainnet-beta.solana.com");
      expect(result).toBe(mockRpcClient);
    });

    it("should create mainnet RPC client with custom URL when provided", () => {
      const customUrl = "https://custom-mainnet-rpc.com";
      const mockRpcClient = { mock: "mainnet-client-custom" };
      vi.mocked(solanaKit.createSolanaRpc).mockReturnValue(mockRpcClient as any);

      const result = createMainnetRpcClient(customUrl);

      expect(solanaKit.mainnet).toHaveBeenCalledWith(customUrl);
      expect(solanaKit.createSolanaRpc).toHaveBeenCalledWith(customUrl);
      expect(result).toBe(mockRpcClient);
    });
  });

  describe("getRpcClient", () => {
    it("should return devnet client for solana-devnet network", () => {
      const mockRpcClient = { mock: "devnet" };
      vi.mocked(solanaKit.createSolanaRpc).mockReturnValue(mockRpcClient as any);

      const result = getRpcClient("solana-devnet");

      expect(solanaKit.devnet).toHaveBeenCalledWith("https://api.devnet.solana.com");
      expect(result).toBe(mockRpcClient);
    });

    it("should return mainnet client for solana network", () => {
      const mockRpcClient = { mock: "mainnet" };
      vi.mocked(solanaKit.createSolanaRpc).mockReturnValue(mockRpcClient as any);

      const result = getRpcClient("solana");

      expect(solanaKit.mainnet).toHaveBeenCalledWith("https://api.mainnet-beta.solana.com");
      expect(result).toBe(mockRpcClient);
    });

    it("should use custom URL when provided for devnet", () => {
      const mockRpcClient = { mock: "devnet-custom" };
      const customUrl = "http://localhost:8899";
      vi.mocked(solanaKit.createSolanaRpc).mockReturnValue(mockRpcClient as any);

      const result = getRpcClient("solana-devnet", customUrl);

      expect(solanaKit.devnet).toHaveBeenCalledWith(customUrl);
      expect(result).toBe(mockRpcClient);
    });

    it("should use custom URL when provided for mainnet", () => {
      const mockRpcClient = { mock: "mainnet-custom" };
      const customUrl = "https://custom-rpc.com";
      vi.mocked(solanaKit.createSolanaRpc).mockReturnValue(mockRpcClient as any);

      const result = getRpcClient("solana", customUrl);

      expect(solanaKit.mainnet).toHaveBeenCalledWith(customUrl);
      expect(result).toBe(mockRpcClient);
    });

    it("should throw error for invalid network", () => {
      expect(() => getRpcClient("invalid-network" as any)).toThrow("Invalid network");
    });
  });

  describe("getRpcSubscriptions", () => {
    it("should return devnet subscriptions with default URL", () => {
      const mockSubscriptions = { mock: "devnet-subscriptions" };
      vi.mocked(solanaKit.createSolanaRpcSubscriptions).mockReturnValue(mockSubscriptions as any);

      const result = getRpcSubscriptions("solana-devnet");

      expect(solanaKit.devnet).toHaveBeenCalledWith("wss://api.devnet.solana.com");
      expect(solanaKit.createSolanaRpcSubscriptions).toHaveBeenCalled();
      expect(result).toBe(mockSubscriptions);
    });

    it("should return mainnet subscriptions with default URL", () => {
      const mockSubscriptions = { mock: "mainnet-subscriptions" };
      vi.mocked(solanaKit.createSolanaRpcSubscriptions).mockReturnValue(mockSubscriptions as any);

      const result = getRpcSubscriptions("solana");

      expect(solanaKit.mainnet).toHaveBeenCalledWith("wss://api.mainnet-beta.solana.com");
      expect(solanaKit.createSolanaRpcSubscriptions).toHaveBeenCalled();
      expect(result).toBe(mockSubscriptions);
    });

    it("should use custom URL when provide (devnet)", () => {
      const mockSubscriptions = { mock: "custom-subscriptions" };
      const customUrl = "wss://custom-rpc.com";
      vi.mocked(solanaKit.createSolanaRpcSubscriptions).mockReturnValue(mockSubscriptions as any);

      const result = getRpcSubscriptions("solana-devnet", customUrl);

      expect(solanaKit.devnet).toHaveBeenCalledWith(customUrl);
      expect(solanaKit.createSolanaRpcSubscriptions).toHaveBeenCalled();
      expect(result).toBe(mockSubscriptions);
    });

    it("should use custom URL when provided (mainnet)", () => {
      const mockSubscriptions = { mock: "custom-subscriptions" };
      const customUrl = "wss://custom-rpc.com";
      vi.mocked(solanaKit.createSolanaRpcSubscriptions).mockReturnValue(mockSubscriptions as any);

      const result = getRpcSubscriptions("solana", customUrl);

      expect(solanaKit.mainnet).toHaveBeenCalledWith(customUrl);
      expect(solanaKit.createSolanaRpcSubscriptions).toHaveBeenCalled();
      expect(result).toBe(mockSubscriptions);
    });

    it("should throw error for invalid network", () => {
      expect(() => getRpcSubscriptions("invalid-network" as any)).toThrow("Invalid network");
    });
  });
});
