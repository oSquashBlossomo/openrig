import { afterEach, expect, it, vi } from "vitest";
import { postJson } from "../src/api.js";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it.each([
  ["/api/transport/send", "stored-token", "Bearer stored-token"],
  ["/api/transport/send", null, null],
  ["https://external.example/send", "stored-token", null],
  [`${window.location.origin}/api/transport/send`, "stored-token", null],
  ["//external.example/send", "stored-token", null],
  ["/\\external.example/send", "stored-token", null],
  ["/\n/external.example/send", "stored-token", null],
])("authenticates only local relative writes: %s, token %s", async (path, token, expected) => {
  if (token) localStorage.setItem("openrig.terminalBearerToken", token);
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"sent":true}', { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await postJson(path!, { session: "fixture@rig", text: "fictional input" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(path);
  expect(new Headers(init.headers).get("Authorization")).toBe(expected);
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ session: "fixture@rig", text: "fictional input" });
});
