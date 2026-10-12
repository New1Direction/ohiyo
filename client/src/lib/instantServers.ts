// Whether this home offers Instant Servers. The hosted service can't make them, and the
// command palette shouldn't offer something that only answers "not available".

export type InstantServersAvailability = "unknown" | "on" | "off";

/** Reads the answer of GET /instances/available. Anything else (an older or self-hosted
 *  server without that endpoint) is "unknown", which changes nothing. */
export function availabilityFrom(body: unknown): InstantServersAvailability {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "unknown";
  const available = (body as { available?: unknown }).available;
  if (available === true) return "on";
  if (available === false) return "off";
  return "unknown";
}

/** Whether to show Instant Servers in the command palette. */
export function offersInstantServers(availability: InstantServersAvailability): boolean {
  return availability !== "off";
}
