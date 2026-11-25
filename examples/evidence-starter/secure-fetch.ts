
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { TcpNetConnectOpts } from "node:net";
import { Agent } from "undici";
import ipaddr from "ipaddr.js";

export type ResolveHost = (
  hostname: string,
) => Promise<LookupAddress[]>;

export type SecureLookup = NonNullable<TcpNetConnectOpts["lookup"]>;

/**
 * Accept only valid IP addresses classified as globally routable unicast.
 */
export function isPublicIpAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) {
    return false;
  }

  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

function createLookupError(
  message: string,
  cause?: unknown,
): NodeJS.ErrnoException {
  return Object.assign(
    new Error(message, { cause }),
    { code: "EACCES" },
  );
}

/**
 * Creates a DNS lookup function that validates every resolved address
 * before passing addresses to Node's socket connector.
 *
 * Resolving all addresses prevents an unsafe address from being hidden
 * behind a public address in a mixed DNS response.
 */
export function createPublicLookup(
  resolveHost: ResolveHost = (hostname) =>
    dnsLookup(hostname, {
      all: true,
      verbatim: true,
    }),
): SecureLookup {
  return (hostname, options, callback) => {
    const fail = (error: NodeJS.ErrnoException): void => {
      if (options.all) {
        callback(error, []);
      } else {
        callback(error, "", 0);
      }
    };

    void resolveHost(hostname)
      .then((addresses) => {
        if (!addresses.length) {
          fail(
            createLookupError(
              `No IP addresses found for ${hostname}`,
            ),
          );
          return;
        }

        const unsafeAddress = addresses.find(
          ({ address }) => !isPublicIpAddress(address),
        );

        if (unsafeAddress) {
          fail(
            createLookupError(
              `Blocked non-public DNS address for ${hostname}: ${unsafeAddress.address}`,
            ),
          );
          return;
        }

        const requestedFamily =
          options.family === "IPv4"
            ? 4
            : options.family === "IPv6"
              ? 6
              : options.family ?? 0;

        const matchingAddresses =
          requestedFamily === 0
            ? addresses
            : addresses.filter(
                ({ family }) => family === requestedFamily,
              );

        if (!matchingAddresses.length) {
          fail(
            createLookupError(
              `No matching IP address family found for ${hostname}`,
            ),
          );
          return;
        }

        if (options.all) {
          callback(null, matchingAddresses);
          return;
        }

        const selectedAddress = matchingAddresses[0];

        callback(
          null,
          selectedAddress.address,
          selectedAddress.family,
        );
      })
      .catch((error: unknown) => {
        const lookupError =
          error instanceof Error
            ? Object.assign(error, {
                code:
                  (error as NodeJS.ErrnoException).code ?? "EAI_AGAIN",
              })
            : createLookupError(
                `DNS resolution failed for ${hostname}`,
                error,
              );

        fail(lookupError as NodeJS.ErrnoException);
      });
  };
}

/**
 * Creates an Undici Agent using the validated DNS lookup.
 *
 * The original hostname is retained by Undici for HTTP Host handling
 * and TLS certificate verification. Only the socket's resolved
 * destination address is controlled by the lookup callback.
 */
export function createSecureAgent(
  resolveHost?: ResolveHost,
): Agent {
  return new Agent({
    connections: 1,

    connect: {
      lookup: createPublicLookup(resolveHost),
    },
  });
}

