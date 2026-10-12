// One picture up to the server's /upload: an avatar, a profile banner, a space logo or a
// custom emoji. (Message attachments go through ChatPane, which also shows progress.)

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
  const data = (await res.json()) as Uploaded[];
  const first = data[0];
  if (!first?.id) throw new Error("Upload failed");
  return first;
}
