
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPrivateKeySigner,
  createCdpSigner,
} from "../../src/client/signer.js";

import type {
  PrivateKeySignerConfig,
  CdpSignerConfig,
} from "../../src/client/signer.js";

// -----------------------------------------------------------------------------
// CDP SDK mock
// -----------------------------------------------------------------------------

const { mockCdpClient, mockGetAccount } = vi.hoisted(() => ({
  mockCdpClient: vi.fn(),
  mockGetAccount: vi.fn(),
}));

vi.mock("@coinbase/cdp-sdk", () => ({
  CdpClient: mockCdpClient,
}));

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

// Well-known Anvil/Hardhat test private key.
// NEVER use this key with real funds.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const TEST_ADDRESS =
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

const CDP_TEST_ADDRESS =
  "0x1234567890123456789012345678901234567890" as const;

const RPC_URL = "https://example.com/rpc";
const CHAIN_ID = 1;

const privateKeyConfig: PrivateKeySignerConfig = {
  privateKey: TEST_PRIVATE_KEY,
  rpcUrl: RPC_URL,
  chainId: CHAIN_ID,
};

const cdpConfig: CdpSignerConfig = {
  apiKeyId: "test-api-key-id",
  apiKeySecret: "test-api-key-secret",
  walletSecret: "test-wallet-secret",
  walletAddress: CDP_TEST_ADDRESS,
  rpcUrl: RPC_URL,
  chainId: CHAIN_ID,
};

const mockCdpAccount = {
  address: CDP_TEST_ADDRESS,
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
  signTypedData: vi.fn(),
};

// -----------------------------------------------------------------------------
// Private-key signer tests
// -----------------------------------------------------------------------------

describe("createPrivateKeySigner", () => {
  it("creates a DelphiSigner with the expected structure", async () => {
    const signer = await createPrivateKeySigner(privateKeyConfig);

    expect(signer).toHaveProperty("address");
    expect(signer).toHaveProperty("walletClient");
    expect(signer).toHaveProperty("publicClient");
  });

  it("derives the correct address from the private key", async () => {
    const signer = await createPrivateKeySigner(privateKeyConfig);

    expect(signer.address).toBe(TEST_ADDRESS);
    expect(signer.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("creates a wallet client configured for the requested chain", async () => {
    const signer = await createPrivateKeySigner(privateKeyConfig);

    expect(signer.walletClient.chain?.id).toBe(CHAIN_ID);
  });

  it("creates a public client configured for the requested chain", async () => {
    const signer = await createPrivateKeySigner(privateKeyConfig);

    expect(signer.publicClient.chain?.id).toBe(CHAIN_ID);
  });

  it("uses the derived account in the wallet client", async () => {
    const signer = await createPrivateKeySigner(privateKeyConfig);

    expect(signer.walletClient.account?.address).toBe(TEST_ADDRESS);
  });

  it("supports a different chain configuration", async () => {
    const signer = await createPrivateKeySigner({
      ...privateKeyConfig,
      chainId: 8453,
    });

    expect(signer.walletClient.chain?.id).toBe(8453);
    expect(signer.publicClient.chain?.id).toBe(8453);
  });
});

// -----------------------------------------------------------------------------
// CDP Server Wallet signer tests
// -----------------------------------------------------------------------------

describe("createCdpSigner", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetAccount.mockResolvedValue(mockCdpAccount);

    // CdpClient is instantiated with `new` in signer.ts.
    // Use a regular function so the mock is constructible.
    mockCdpClient.mockImplementation(function () {
      return {
        evm: {
          getAccount: mockGetAccount,
        },
      };
    });
  });

  it("creates a DelphiSigner with the expected structure", async () => {
    const signer = await createCdpSigner(cdpConfig);

    expect(signer).toHaveProperty("address");
    expect(signer).toHaveProperty("walletClient");
    expect(signer).toHaveProperty("publicClient");
  });

  it("uses the configured CDP wallet address", async () => {
    const signer = await createCdpSigner(cdpConfig);

    expect(signer.address).toBe(CDP_TEST_ADDRESS);
    expect(signer.walletClient.account?.address).toBe(CDP_TEST_ADDRESS);
  });

  it("initialises CDP with the supplied credentials", async () => {
    await createCdpSigner(cdpConfig);

    expect(mockCdpClient).toHaveBeenCalledWith({
      apiKeyId: cdpConfig.apiKeyId,
      apiKeySecret: cdpConfig.apiKeySecret,
      walletSecret: cdpConfig.walletSecret,
    });

    expect(mockCdpClient).toHaveBeenCalledTimes(1);
  });

  it("retrieves the requested wallet account from CDP", async () => {
    await createCdpSigner(cdpConfig);

    expect(mockGetAccount).toHaveBeenCalledWith({
      address: cdpConfig.walletAddress,
    });

    expect(mockGetAccount).toHaveBeenCalledTimes(1);
  });

  it("creates a wallet client configured for the requested chain", async () => {
    const signer = await createCdpSigner(cdpConfig);

    expect(signer.walletClient.chain?.id).toBe(CHAIN_ID);
  });

  it("creates a public client configured for the requested chain", async () => {
    const signer = await createCdpSigner(cdpConfig);

    expect(signer.publicClient.chain?.id).toBe(CHAIN_ID);
  });

  it("supports a different chain configuration", async () => {
    const signer = await createCdpSigner({
      ...cdpConfig,
      chainId: 8453,
    });

    expect(signer.walletClient.chain?.id).toBe(8453);
    expect(signer.publicClient.chain?.id).toBe(8453);
  });

  it("propagates errors when CDP account retrieval fails", async () => {
    mockGetAccount.mockRejectedValueOnce(
      new Error("CDP account retrieval failed"),
    );

    await expect(createCdpSigner(cdpConfig)).rejects.toThrow(
      "CDP account retrieval failed",
    );
  });

  it("does not create a signer when CDP account retrieval fails", async () => {
    mockGetAccount.mockRejectedValueOnce(
      new Error("Wallet not found"),
    );

    await expect(createCdpSigner(cdpConfig)).rejects.toThrow(
      "Wallet not found",
    );
  });

  it("propagates CDP client initialisation errors", async () => {
    mockCdpClient.mockImplementationOnce(function () {
      throw new Error("CDP initialisation failed");
    });

    await expect(createCdpSigner(cdpConfig)).rejects.toThrow(
      "CDP initialisation failed",
    );

    expect(mockGetAccount).not.toHaveBeenCalled();
  });
});
