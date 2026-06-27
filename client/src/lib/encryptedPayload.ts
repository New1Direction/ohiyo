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

export function unpackEncryptedMessagePlaintext(plain: string): { text: string; attachments?: EncryptedAttachmentMeta[] } {
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
              typeof a.encrypted.iv === "string"
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
