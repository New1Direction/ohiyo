// One picture up to the server's /upload: an avatar, a profile banner, a space logo or a
// custom emoji. (Message attachments go through ChatPane, which also shows progress.)
// A refusal is the server's own plain sentence, such as "Ohiyo is short on storage right
// now. Try again later." when the disk is down to its reserve, so it is thrown as is, with
// the HTTP status on `status` like api.ts's errors.

export type Uploaded = { id: string; url: string };

export async function uploadOne(
  apiBase: string,
  token: string,
  file: Blob,
  fetchImpl: typeof fetch = fetch,
): Promise<Uploaded> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetchImpl(`${apiBase}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const said = (await res.text().catch(() => "")).trim();
    throw Object.assign(new Error(said || `Upload failed (HTTP ${res.status})`), { status: res.status });
  }
  const data = (await res.json()) as Uploaded[];
  const first = data[0];
  if (!first?.id) throw new Error("Upload failed");
  return first;
}
