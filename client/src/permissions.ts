// Mirror of the server's permission bitflags (server/src/api/roles.rs).
export const PERM = {
  MANAGE_CHANNELS: 1 << 0,
  MANAGE_MESSAGES: 1 << 1,
  KICK_MEMBERS: 1 << 2,
  BAN_MEMBERS: 1 << 3,
  MANAGE_ROLES: 1 << 4,
  MANAGE_SERVER: 1 << 5,
  VIEW_CHANNEL: 1 << 6,
  SEND_MESSAGES: 1 << 7,
  ADMINISTRATOR: 1 << 8,
} as const;

export type PermFlag = (typeof PERM)[keyof typeof PERM];

export const PERM_LABELS: { flag: PermFlag; label: string; hint: string }[] = [
  { flag: PERM.MANAGE_CHANNELS, label: "Manage channels", hint: "Create & delete channels" },
  { flag: PERM.MANAGE_MESSAGES, label: "Manage messages", hint: "Delete anyone's messages, pin" },
  { flag: PERM.KICK_MEMBERS, label: "Kick members", hint: "Remove members (they can rejoin)" },
  { flag: PERM.BAN_MEMBERS, label: "Ban members", hint: "Remove & block from rejoining" },
  { flag: PERM.MANAGE_ROLES, label: "Manage roles", hint: "Create roles & assign them" },
  { flag: PERM.MANAGE_SERVER, label: "Manage server", hint: "Rename and customize the server" },
  { flag: PERM.VIEW_CHANNEL, label: "View channels", hint: "See channels by default" },
  { flag: PERM.SEND_MESSAGES, label: "Send messages", hint: "Post in text channels by default" },
  { flag: PERM.ADMINISTRATOR, label: "Administrator", hint: "Bypass channel overwrites" },
];

export const can = (perms: number, flag: number): boolean => (perms & flag) !== 0;
