// Which painting and greeting the sign-in screen shows. Ohiyo sounds like "ohayo", good
// morning, so the door greets you by the hour. Pure, for unit tests.

export type DoorSceneKey = "sunrise" | "morning" | "day" | "sunset" | "night";

export interface DoorScene {
  key: DoorSceneKey;
  /** The big line. */
  greeting: string;
  /** The small line under it. */
  line: string;
  /** Whether the painting is light (dark words on it) or dark (light words). */
  tone: "light" | "dark";
}

const EVERYONE = "Your people are in here.";
const DAYTIME_HOUR = 12;

/** The scene for an hour of the local day (0 to 23). Anything else gets the daytime one. */
export function doorScene(hour: number): DoorScene {
  const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DAYTIME_HOUR;
  if (h < 5) return { key: "night", greeting: "Still up?", line: "So are the fireflies.", tone: "dark" };
  if (h < 8) return { key: "sunrise", greeting: "Good morning.", line: "You nearly beat the sun.", tone: "light" };
  if (h < 12) return { key: "morning", greeting: "Good morning.", line: EVERYONE, tone: "light" };
  if (h < 17) return { key: "day", greeting: "Good afternoon.", line: EVERYONE, tone: "light" };
  if (h < 21) return { key: "sunset", greeting: "Good evening.", line: EVERYONE, tone: "light" };
  return { key: "night", greeting: "Good evening.", line: EVERYONE, tone: "dark" };
}
