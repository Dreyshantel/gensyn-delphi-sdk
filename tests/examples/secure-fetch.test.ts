
import { createServer } from "node:http";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { TcpNetConnectOpts } from "node:net";
import { describe, expect, it } from "vitest";
import { fetch as undiciFetch } from "undici";

import {
  createPublicLookup,
  createSecureAgent,
  isPublicIpAddress,
} from "../../examples/evidence-starter/secure-fetch.js";

type SecureLookup = NonNullable<TcpNetConnectOpts["lookup"]>;

interface LookupResult {
  error: NodeJS.ErrnoException | null;
  addresses: LookupAddress[];
  address?: string;
  family?: number;
}

function invokeLookup(
  lookup: SecureLookup,
  options: LookupOptions,
): Promise<LookupResult> {
  return new Promise((resolve) => {
    lookup("example.com", options, (error, result, family) => {
      resolve({
        error,
        addresses: Array.isArray(result) ? result : [],
        address: typeof result === "string" ? result : undefined,
        family,
      });
    });
  });
}

describe("secure fetch IP validation", () => {
  describe("public IPv4 addresses", () => {
    it.each([
      "8.8.8.8",
      "1.1.1.1",
      "9.9.9.9",
    ])("accepts %s", (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    });
  });

  describe("non-public IPv4 addresses", () => {
    it.each([
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ])("rejects %s", (address) => {
      expect(isPublicIpAddress(address)).toBe(false);
    });
  });

  describe("public IPv6 addresses", () => {
    it.each([
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ])("accepts %s", (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    });
  });

  describe("non-public IPv6 addresses", () => {
    it.each([
      "::",
      "::1",
      "fc00::1",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ])("rejects %s", (address) => {
      expect(isPublicIpAddress(address)).toBe(false);
    });
  });

  describe("invalid addresses", () => {
    it.each([
      "",
      "localhost",
      "not-an-ip",
      "999.999.999.999",
    ])("rejects %s", (address) => {
      expect(isPublicIpAddress(address)).toBe(false);
    });
  });
});

describe("secure DNS lookup", () => {
  it("accepts public DNS results in all-address mode", async () => {
    const lookup = createPublicLookup(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    const result = await invokeLookup(lookup, {
      all: true,
      family: 0,
    });

    expect(result.error).toBeNull();
    expect(result.addresses).toHaveLength(2);
  });

  it("accepts a public DNS result in single-address mode", async () => {
    const lookup = createPublicLookup(async () => [
      { address: "1.1.1.1", family: 4 },
    ]);

    const result = await invokeLookup(lookup, {
      all: false,
      family: 0,
    });

    expect(result.error).toBeNull();
    expect(result.address).toBe("1.1.1.1");
    expect(result.family).toBe(4);
  });

  it("rejects a private DNS result", async () => {
    const lookup = createPublicLookup(async () => [
      { address: "192.168.1.10", family: 4 },
    ]);

    const result = await invokeLookup(lookup, {
      all: true,
    });

    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain(
      "Blocked non-public DNS address",
    );
  });

  it("rejects mixed public and private DNS results", async () => {
    const lookup = createPublicLookup(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    const result = await invokeLookup(lookup, {
      all: true,
    });

    expect(result.error).not.toBeNull();
    expect(result.addresses).toHaveLength(0);
  });

  it("propagates DNS resolution errors", async () => {
    const lookup = createPublicLookup(async () => {
      throw Object.assign(
        new Error("DNS lookup failed"),
        { code: "ENOTFOUND" },
      );
    });

    const result = await invokeLookup(lookup, {
      all: false,
    });

    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe("DNS lookup failed");
    expect(result.error?.code).toBe("ENOTFOUND");
  });

  it("rejects empty DNS results", async () => {
    const lookup = createPublicLookup(async () => []);

    const result = await invokeLookup(lookup, {
      all: true,
    });

    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain(
      "No IP addresses found",
    );
  });

  it("filters validated results by requested IPv4 family", async () => {
    const lookup = createPublicLookup(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    const result = await invokeLookup(lookup, {
      all: true,
      family: 4,
    });

    expect(result.error).toBeNull();
    expect(result.addresses).toEqual([
      { address: "8.8.8.8", family: 4 },
    ]);
  });

  it("rejects when no address matches the requested family", async () => {
    const lookup = createPublicLookup(async () => [
      { address: "8.8.8.8", family: 4 },
    ]);

    const result = await invokeLookup(lookup, {
      all: true,
      family: 6,
    });

    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain(
      "No matching IP address family",
    );
  });
});

describe("secure Undici connection", () => {
  it("blocks a connection when DNS resolves a hostname to loopback", async () => {
    let receivedRequests = 0;
    let resolverCalled = false;

    const server = createServer((_request, response) => {
      receivedRequests++;
      response.end("This request should never reach the server");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const serverAddress = server.address();

    if (!serverAddress || typeof serverAddress === "string") {
      server.close();
      throw new Error("Could not determine local test server port");
    }

    const agent = createSecureAgent(async (hostname) => {
      resolverCalled = true;

      expect(hostname).toBe("blocked.test");

      return [
        {
          address: "127.0.0.1",
          family: 4,
        },
      ];
    });

    try {
      const requestError = await undiciFetch(
        `http://blocked.test:${serverAddress.port}/`,
        {
          dispatcher: agent,
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(resolverCalled).toBe(true);
      expect(requestError).toBeInstanceOf(TypeError);

      expect(
        (requestError as Error).cause,
      ).toMatchObject({
        code: "EACCES",
      });

      expect(receivedRequests).toBe(0);
    } finally {
      try {
        await agent.close();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    }
  });
});

