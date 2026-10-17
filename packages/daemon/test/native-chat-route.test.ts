import { expect, it, vi } from "vitest";
import { nativeChatRoutes } from "../src/routes/native-chat.js";
import { NativeChatError, type NativeChatService } from "../src/domain/native-chat.js";

it("keeps unexpected post-effect errors unknown and does not disclose private paths", async () => {
  const service = { send: vi.fn(async () => { throw new Error("SQLITE_FULL /private/native-history.jsonl"); }) } as unknown as NativeChatService;
  const app = nativeChatRoutes(service);
  const response = await app.request("/node/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "id", ownerKey: "owner", text: "hello" }) });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("/private");
});
it("requires the terminal bearer for history and sends and retains proved validation refusals", async () => {
  const service = { read: vi.fn(), send: vi.fn(async () => { throw new NativeChatError("invalid_message", "Use Terminal.", 400); }) } as unknown as NativeChatService;
  const app = nativeChatRoutes(service, "test-token");
  expect((await app.request("/node")).status).toBe(401);
  expect((await app.request("/node/messages", { method: "POST", body: "{}" })).status).toBe(401);
  expect(service.read).not.toHaveBeenCalled(); expect(service.send).not.toHaveBeenCalled();
  expect((await app.request("/node/messages", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: "{}" })).status).toBe(400);
});
it("rejects oversized bodies before dispatch", async () => {
  const send = vi.fn(); const app = nativeChatRoutes({ send } as unknown as NativeChatService);
  const response = await app.request("/node/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x".repeat(130 * 1024) }) });
  expect(response.status).toBe(413); expect(send).not.toHaveBeenCalled();
});
