// Not built yet.
import { mentionsYou } from "./mentions.ts";

type Author = { display_name: string; bot?: boolean };

export function notificationTitle(author: Author): string {
  return author.display_name;
}

export function mentionsMe(content: string, _author: { bot?: boolean }, username: string): boolean {
  return mentionsYou(content, username);
}
