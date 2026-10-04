/** What to show for a failed request: the server's own message when it sent one (a 400
 *  such as "bio is too long (max 500 characters)" arrives as the Error's message), else
 *  `fallback`. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback;
}
