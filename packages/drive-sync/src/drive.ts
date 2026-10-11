export interface DriveFileStore {
  read(name: string): Promise<string | null>;
  write(name: string, content: string): Promise<void>;
  remove(name: string): Promise<void>;
}

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/** Files live in the hidden appDataFolder (scope drive.appdata). */
export function createDriveStore(getToken: () => Promise<string>, fetchImpl: typeof fetch = fetch): DriveFileStore {
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getToken();
    const res = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    if (!res.ok && res.status !== 404) throw new Error(`Drive request failed: ${res.status}`);
    return res;
  }

  async function findId(name: string): Promise<string | null> {
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}'`);
    const res = await call(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
    const body = (await res.json()) as { files?: { id: string }[] };
    return body.files?.[0]?.id ?? null;
  }

  return {
    async read(name) {
      const id = await findId(name);
      if (!id) return null;
      const res = await call(`${API}/files/${id}?alt=media`);
      return res.status === 404 ? null : res.text();
    },
    async write(name, content) {
      const id = await findId(name);
      const boundary = "lfk" + Math.random().toString(36).slice(2);
      const meta = id ? {} : { name, parents: ["appDataFolder"] };
      const body =
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
      const url = id ? `${UPLOAD}/files/${id}?uploadType=multipart` : `${UPLOAD}/files?uploadType=multipart`;
      await call(url, {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
    },
    async remove(name) {
      const id = await findId(name);
      if (id) await call(`${API}/files/${id}`, { method: "DELETE" });
    },
  };
}
