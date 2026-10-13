// What a desktop notification says about a message's author, and whether a message counts
// as mentioning you. A webhook is another service posting, not a person: its notifications
// say "(app)", and naming you doesn't count as a mention, so it can't get through a mute
// (the server's push relay follows the same rule).
import { mentionsYou } from "./mentions.ts";

type Author = { display_name: string; bot?: boolean };

/** The notification's title: the author's name, marked when it's a webhook. */
export function notificationTitle(author: Author): string {
  return author.bot ? `${author.display_name} (app)` : author.display_name;
}

/** True if a message from `author` mentions you; never for a webhook. */
export function mentionsMe(content: string, author: { bot?: boolean }, username: string): boolean {
  return !author.bot && mentionsYou(content, username);
}
