// What a username is made of. New names use letters, numbers, dots, dashes and underscores,
// 2–32 characters (the server refuses anything else). The sign-up form and @mentions read
// names with the same characters.

export const MIN_USERNAME = 2;
export const MAX_USERNAME = 32;

/** One character a username may contain, as a regular-expression character class. */
export const USERNAME_CHAR = "[A-Za-z0-9._-]";
