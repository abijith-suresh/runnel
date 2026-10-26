import { ConnectionString } from "mongodb-connection-string-url";

/** Syntax validation only. No native client, DNS lookup, authentication or enumeration. */
export function mongoConnectionDatabase(uri: string): string | undefined {
  try {
    const parsed = new ConnectionString(uri);
    // ConnectionString parses the host list but leaves TCP ports unchecked.
    // Use WHATWG URL host/port validation as the driver does, without a client.
    // Encoded Unix sockets retain the driver's separate socket-path syntax.
    for (const host of parsed.hosts) {
      const escaped = host.replaceAll(" ", "%20");
      if (escaped.endsWith(".sock")) {
        decodeURIComponent(escaped);
        continue;
      }
      const address = new URL(`mongodb://${escaped}`);
      decodeURIComponent(address.hostname);
      if (!address.hostname || address.port === "0") throw new Error("Invalid host or port");
    }
    // Reject malformed percent encoding without ever returning credential-bearing diagnostics.
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    return database || undefined;
  } catch {
    throw new Error("The MongoDB connection string is invalid.");
  }
}
