import type { AttachmentMeta } from "../api";

const PREFIX = "\u001fOHIYO_MSG1.";
const te = new TextEncoder();
const td = new TextDecoder();

export type EncryptedAttachmentKey = {
  alg: "AES-256-GCM";
  key: string;
  iv: string;
  cipher_size_bytes: number;
};

export type EncryptedAttachmentMeta = AttachmentMeta & {
  encrypted: EncryptedAttachmentKey;
};

type PackedMessage = {
  v: 1;
  text: string;
  attachments?: EncryptedAttachmentMeta[];
};

function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function packEncryptedMessagePlaintext(text: string, attachments?: EncryptedAttachmentMeta[]): string {
  if (!attachments?.length) return text;
  const body: PackedMessage = { v: 1, text, attachments };
  return `${PREFIX}${toB64Url(te.encode(JSON.stringify(body)))}`;
}

// Server file ids are UUIDs; accept only a plain token so it can't add path segments.
const FILE_ID = /^[A-Za-z0-9-]+$/;

/** The absolute URL to fetch an encrypted attachment's ciphertext from — only when its
 *  `url` (sender-controlled: it arrives inside the encrypted message) is the
 *  `/files/<id>` path of this attachment on the current home; null otherwise. */
export function homeFileUrl(att: { id: string; url?: string }, homeOrigin: string): string | null {
  if (!FILE_ID.test(att.id)) return null;
  try {
    const home = new URL(homeOrigin);
    const u = new URL(att.url ?? `/files/${att.id}`, home);
    if (u.origin !== home.origin || u.username || u.password) return null;
    if (u.pathname !== `/files/${att.id}`) return null;
    return u.href;
  } catch {
    return null;
  }
}

// Types a decrypted attachment Blob may carry. The type is sender-controlled; anything
// that could run script when its blob: URL is opened (SVG, HTML, XML…) must not pass.
const SAFE_BLOB_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "audio/flac",
  "application/pdf",
  "text/plain",
]);

/** The MIME type for a decrypted attachment Blob: the claimed type if allowlisted, else
 *  application/octet-stream. */
export function safeAttachmentBlobType(contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  return SAFE_BLOB_TYPES.has(type) ? type : "application/octet-stream";
}

/** Unpack a decrypted message. Attachments whose URL isn't a `/files/<id>` path on
 *  `homeOrigin` (the current home) are dropped. */
export function unpackEncryptedMessagePlaintext(
  plain: string,
  homeOrigin: string,
): { text: string; attachments?: EncryptedAttachmentMeta[] } {
  if (!plain.startsWith(PREFIX)) return { text: plain };
  try {
    const body = JSON.parse(td.decode(fromB64Url(plain.slice(PREFIX.length)))) as Partial<PackedMessage>;
    if (body.v !== 1 || typeof body.text !== "string") return { text: plain };
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((a): a is EncryptedAttachmentMeta => {
          return Boolean(
            a &&
              typeof a.id === "string" &&
              typeof a.filename === "string" &&
              typeof a.content_type === "string" &&
              typeof a.size_bytes === "number" &&
              a.encrypted?.alg === "AES-256-GCM" &&
              typeof a.encrypted.key === "string" &&
              typeof a.encrypted.iv === "string" &&
              (a.url === undefined || typeof a.url === "string") &&
              homeFileUrl(a, homeOrigin) !== null
          );
        })
      : undefined;
    return { text: body.text, attachments };
  } catch {
    return { text: plain };
  }
}

export function isEncryptedAttachment(att: AttachmentMeta): att is EncryptedAttachmentMeta {
  return (att as EncryptedAttachmentMeta).encrypted?.alg === "AES-256-GCM";
}

