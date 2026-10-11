import { describe, expect, it } from "vitest";
import { createDriveStore } from "./drive";

function fakeFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let stored: string | null = null;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (url.includes("/files?spaces=appDataFolder"))
      return new Response(JSON.stringify({ files: stored === null ? [] : [{ id: "f1" }] }));
    if (url.includes("alt=media")) return new Response(stored ?? "", { status: stored === null ? 404 : 200 });
    if (method === "POST" || method === "PATCH") {
      stored = String(init!.body).split("\r\n\r\n")[2].split("\r\n--")[0];
      return new Response("{}");
    }
    if (method === "DELETE") { stored = null; return new Response(null, { status: 204 }); }
    return new Response("", { status: 500 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("createDriveStore", () => {
  it("creates, reads, updates and removes a file with bearer auth", async () => {
    const { impl, calls } = fakeFetch();
    const store = createDriveStore(async () => "tok", impl);
    expect(await store.read("a.json")).toBeNull();
    await store.write("a.json", '{"x":1}');
    expect(calls.at(-1)!.init!.method).toBe("POST");
    expect(calls.at(-1)!.url).toContain("uploadType=multipart");
    expect(String(calls.at(-1)!.init!.body)).toContain('"parents":["appDataFolder"]');
    expect(await store.read("a.json")).toBe('{"x":1}');
    await store.write("a.json", '{"x":2}');
    expect(calls.at(-1)!.init!.method).toBe("PATCH");
    await store.remove("a.json");
    expect(await store.read("a.json")).toBeNull();
    expect(calls.every((c) => (c.init!.headers as Record<string, string>).Authorization === "Bearer tok")).toBe(true);
  });
  it("throws on server errors", async () => {
    const store = createDriveStore(async () => "t", (async () => new Response("", { status: 500 })) as unknown as typeof fetch);
    await expect(store.read("a")).rejects.toThrow("500");
  });
});
