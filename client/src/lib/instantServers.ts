// Whether this home offers Instant Servers. The hosted service can't make them, and the
// command palette shouldn't offer something that only answers "not available".

export type InstantServersAvailability = "unknown" | "on" | "off";

/** Reads the answer of GET /instances/available. */
export function availabilityFrom(_body: unknown): InstantServersAvailability {
  return "unknown";
}

/** Whether to show Instant Servers in the command palette. */
export function offersInstantServers(_availability: InstantServersAvailability): boolean {
  return true;
}
