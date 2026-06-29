// Encrypted recovery backup — recovery-code model (self-custody).
//
// The server is deliberately a dumb blob store: it never sees the recovery code,
// key material, or the manifest blind key. v2 keeps a small public coverage
// manifest, but all handles in that manifest are HMACs under a key derived from
// the user's recovery code. This is load-bearing: room ids and sender-key ids are
// low-entropy / server-issued, so a server-derived or server-stored blind key would
// let the issuer enumerate every room/key and undo the privacy property.
//
// Snapshot now, continuous later: v2 is shaped as append/merge-friendly entries with
// per-entry provenance so future continuous backup is a superset of today's snapshot,
// not a migration from a convenient flat blob.
//
// No hand-rolled crypto primitives: PBKDF2 + AES-GCM + HMAC via Web Crypto. No deps.

// Unambiguous alphabet (no 0/O/1/I/L) for codes a human can transcribe.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 24; // ~118 bits of entropy
const PBKDF2_ITERS = 210_000;
const te = new TextEncoder();
const td = new TextDecoder();

function b64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
}
function b64d(s: string): ArrayBuffer {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
}

/** Uniform random index in [0, max) via rejection sampling (no modulo bias). */
function randIndex(max: number): number {
  const limit = 256 - (256 % max);
  const b = new Uint8Array(1);
  do {
    crypto.getRandomValues(b);
  } while (b[0] >= limit);
  return b[0] % max;
}

/** A fresh recovery code, grouped for readability: "ABCDE-FGHJK-...". */
export function generateRecoveryCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[randIndex(ALPHABET.length)];
  return (s.match(/.{1,5}/g) ?? [s]).join("-");
}

/** Strip formatting (case, dashes, spaces) so entry is forgiving. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type BackupBlobV1 = { v: 1; salt: string; iv: string; ct: string };

export type BackupEntryV2 = {
  /** Stable HMAC handle for this stored item. Not the localStorage key. */
  id: string;
  namespace: string;
  name: string;
  value: string;
  /** Per-entry provenance; top-level device_id would lie once multiple devices merge. */
  source_device_id: number | null;
  created_at: number;
  updated_at: number;
  room_blind?: string;
  key_blind?: string;
  epoch?: number | null;
};

export type BackupPlaintextV2 = {
  v: 2;
  created_at: number;
  updated_at: number;
  entries: Record<string, BackupEntryV2>;
};

export type BackupPublicManifestV2 = {
  v: 1;
  created_at: number;
  updated_at: number;
  entry_count: number;
  /** Opaque room handles only. No clear room ids and no per-room timestamps/activity windows. */
  room_blinds: string[];
  /** Opaque message-key handles. Computable only after entering the recovery code. */
  key_blinds: string[];
};

export type BackupBlobV2 = {
  v: 2;
  kdf: { name: "PBKDF2-SHA256"; iterations: number };
  salt: string;
  iv: string;
  ct: string;
  public_manifest: BackupPublicManifestV2;
};

export type BackupBlob = BackupBlobV1 | BackupBlobV2;

async function deriveV1Key(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = te.encode(normalizeRecoveryCode(code));
  const baseKey = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveV2Secrets(code: string, salt: Uint8Array): Promise<{ aesKey: CryptoKey; blindKey: CryptoKey }> {
  const material = te.encode(normalizeRecoveryCode(code));
  const baseKey = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
      baseKey,
      512,
    ),
  );
  const aesKey = await crypto.subtle.importKey("raw", bits.slice(0, 32), { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const blindKey = await crypto.subtle.importKey("raw", bits.slice(32, 64), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return { aesKey, blindKey };
}

async function hmacBlind(blindKey: CryptoKey, label: string): Promise<string> {
  return b64(await crypto.subtle.sign("HMAC", blindKey, te.encode(label)));
}

function namespaceOf(key: string): string {
  if (key.startsWith("kc:sig:")) return "signal";
  if (key.startsWith("kc:sk:")) return "sender_key";
  if (key.startsWith("kc:e2e-keypair")) return "legacy_e2e";
  if (key.startsWith("kc:e2e-pt:")) return "plaintext_cache";
  return "unknown";
}

type SenderKeyDescriptor = { roomId: string; epoch: number | null; keyId: string | null };

function senderKeyDescriptor(key: string, value: string): SenderKeyDescriptor | null {
  if (!key.startsWith("kc:sk:own:") && !key.startsWith("kc:sk:peer:")) return null;
  const parts = key.split(":");
  // kc:sk:own:<roomId> or kc:sk:peer:<roomId>:<userId>
  const roomId = parts[3];
  if (!roomId) return null;
  try {
    const parsed = JSON.parse(value) as { epoch?: number; keyId?: number | string };
    return {
      roomId,
      epoch: typeof parsed.epoch === "number" ? parsed.epoch : null,
      keyId: parsed.keyId === undefined || parsed.keyId === null ? null : String(parsed.keyId),
    };
  } catch {
    return { roomId, epoch: null, keyId: null };
  }
}

function sourceDeviceId(material: Record<string, string>): number | null {
  const raw = material["kc:sig:deviceId"];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function buildPlaintextV2(code: string, material: Record<string, string>, salt: Uint8Array, now: number): Promise<BackupPlaintextV2> {
  const { blindKey } = await deriveV2Secrets(code, salt);
  const source_device_id = sourceDeviceId(material);
  const entries: Record<string, BackupEntryV2> = {};
  for (const [name, value] of Object.entries(material).sort(([a], [b]) => a.localeCompare(b))) {
    const id = await hmacBlind(blindKey, `entry:${name}`);
    const sk = senderKeyDescriptor(name, value);
    const room_blind = sk ? await hmacBlind(blindKey, `room:${sk.roomId}`) : undefined;
    const key_blind = sk?.keyId ? await hmacBlind(blindKey, `grp1:${sk.roomId}:${sk.epoch ?? "?"}:${sk.keyId}`) : undefined;
    entries[id] = {
      id,
      namespace: namespaceOf(name),
      name,
      value,
      source_device_id,
      created_at: now,
      updated_at: now,
      room_blind,
      key_blind,
      epoch: sk?.epoch ?? null,
    };
  }
  return { v: 2, created_at: now, updated_at: now, entries };
}

function publicManifest(plain: BackupPlaintextV2): BackupPublicManifestV2 {
  return {
    v: 1,
    created_at: plain.created_at,
    updated_at: plain.updated_at,
    entry_count: Object.keys(plain.entries).length,
    room_blinds: [...new Set(Object.values(plain.entries).map((e) => e.room_blind).filter((v): v is string => Boolean(v)))],
    key_blinds: [...new Set(Object.values(plain.entries).map((e) => e.key_blind).filter((v): v is string => Boolean(v)))],
  };
}

/** Wrap key material under a recovery code. Returns an opaque, uploadable blob.
 * v2 is intentionally keys-only by default; readable plaintext-cache backup is a
 * separate privacy decision, because uploading decrypted message cache — even wrapped
 * zero-knowledge — changes the threat model from "server never stores plaintext" to
 * "server stores user-encrypted plaintext backups." */
export async function encryptBackup(code: string, material: Record<string, string>): Promise<BackupBlobV2> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { aesKey } = await deriveV2Secrets(code, salt);
  const now = Math.floor(Date.now() / 1000);
  const plain = await buildPlaintextV2(code, material, salt, now);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, te.encode(JSON.stringify(plain)));
  return {
    v: 2,
    kdf: { name: "PBKDF2-SHA256", iterations: PBKDF2_ITERS },
    salt: b64(salt.buffer),
    iv: b64(iv.buffer),
    ct: b64(ct),
    public_manifest: publicManifest(plain),
  };
}

function materialFromPlaintextV2(plain: BackupPlaintextV2): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of Object.values(plain.entries)) {
    if (typeof entry.name === "string" && typeof entry.value === "string") out[entry.name] = entry.value;
  }
  return out;
}

/** Unwrap a backup blob with the recovery code. Throws if the code is wrong or
 * the blob is tampered (AES-GCM auth failure). v1 flat blobs remain readable. */
export async function decryptBackup(code: string, blob: BackupBlob): Promise<Record<string, string>> {
  const salt = new Uint8Array(b64d(blob.salt));
  const iv = new Uint8Array(b64d(blob.iv));
  if (blob.v === 1) {
    const key = await deriveV1Key(code, salt);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, b64d(blob.ct));
    return JSON.parse(td.decode(pt)) as Record<string, string>;
  }
  const { aesKey } = await deriveV2Secrets(code, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, b64d(blob.ct));
  const plain = JSON.parse(td.decode(pt)) as BackupPlaintextV2;
  if (plain.v !== 2 || !plain.entries || typeof plain.entries !== "object") throw new Error("unsupported backup");
  return materialFromPlaintextV2(plain);
}

export type BackupSummary = {
  version: number;
  updated_at: number | null;
  entry_count: number | null;
  room_count: number | null;
  key_count: number | null;
};

export function backupSummary(blob: BackupBlob | Record<string, unknown>): BackupSummary {
  if ((blob as BackupBlobV2).v === 2) {
    const manifest = (blob as BackupBlobV2).public_manifest;
    return {
      version: 2,
      updated_at: manifest?.updated_at ?? null,
      entry_count: manifest?.entry_count ?? null,
      room_count: manifest?.room_blinds?.length ?? null,
      key_count: manifest?.key_blinds?.length ?? null,
    };
  }
  return { version: 1, updated_at: null, entry_count: null, room_count: null, key_count: null };
}

export type RecoveryMaterialReport = {
  total: number;
  importable: number;
  ignored: number;
  signal_sessions: number;
  signal_identity: boolean;
  sender_keys: number;
  legacy_keypair: boolean;
  plaintext_cache_entries: number;
};

export function recoveryMaterialReport(material: Record<string, string>): RecoveryMaterialReport {
  const keys = Object.keys(material);
  const importable = keys.filter((key) =>
    key.startsWith("kc:sig:") || key.startsWith("kc:sk:") || key.startsWith("kc:e2e-keypair") || key.startsWith("kc:e2e-pt:"),
  );
  return {
    total: keys.length,
    importable: importable.length,
    ignored: keys.length - importable.length,
    signal_sessions: keys.filter((key) => key.startsWith("kc:sig:session")).length,
    signal_identity: keys.includes("kc:sig:identityKey"),
    sender_keys: keys.filter((key) => key.startsWith("kc:sk:")).length,
    legacy_keypair: keys.some((key) => key.startsWith("kc:e2e-keypair")),
    plaintext_cache_entries: keys.filter((key) => key.startsWith("kc:e2e-pt:")).length,
  };
}

export type CoverageCheck =
  | "covered"
  | "not_covered"
  | "unavailable"
  | "signal_restorable"
  | "signal_missing_session"
  | "signal_not_addressed"
  | "signal_corrupt";

/**
 * Check whether a v2 backup manifest appears to cover a group sender key.
 *
 * This intentionally requires the recovery code. The server issued room ids and can
 * enumerate epoch/key-id candidates, so a server-readable blind key would make the
 * manifest de-blindable. Fresh-device classification is therefore recovery-secret-gated:
 * account auth alone is not enough to learn coverage.
 */
export async function backupCoversSenderKey(
  code: string,
  blob: BackupBlob | Record<string, unknown>,
  roomId: string,
  epoch: number | null,
  keyId: string | number,
): Promise<CoverageCheck> {
  if ((blob as BackupBlobV2).v !== 2) return "unavailable";
  const backup = blob as BackupBlobV2;
  const salt = new Uint8Array(b64d(backup.salt));
  const { blindKey } = await deriveV2Secrets(code, salt);
  const blind = await hmacBlind(blindKey, `grp1:${roomId}:${epoch ?? "?"}:${String(keyId)}`);
  return backup.public_manifest.key_blinds.includes(blind) ? "covered" : "not_covered";
}
