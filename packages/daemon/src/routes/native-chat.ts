import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { NativeChatError, NativeChatService } from "../domain/native-chat.js";

export function nativeChatRoutes(service: NativeChatService, bearerToken: string | null = null): Hono {
  const router = new Hono();
  router.use("*", authBearerTokenMiddleware({ expectedToken: bearerToken }));
  router.use("*", bodyLimit({ maxSize: 128 * 1024, onError: c => c.json({ error: "Native chat request is too large.", code: "request_too_large" }, 413) }));
  // The enclosing server's browser boundary handles origins. Native paths,
  // process argv and unexpected adapter errors never become API error text.
  router.onError((error, c) => error instanceof NativeChatError
    ? c.json({ error: error.message, code: error.code }, error.status)
    : c.json({ error: "Native chat could not verify this operation. Open Terminal.", code: "native_chat_unavailable" }, 500));
  router.get("/:nodeId", async c => {
    const before = c.req.query("before");
    if (before && before.length > 512) throw new NativeChatError("invalid_cursor", "Invalid history cursor.", 400);
    return c.json(await service.read(c.req.param("nodeId"), before));
  });
  for (const [path, kind] of [["messages", "message"], ["interrupt", "interrupt"]] as const) {
    router.post(`/:nodeId/${path}`, async c => {
      let body;
      try { body = await c.req.json(); } catch { throw new NativeChatError("invalid_json", "Expected a JSON request.", 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new NativeChatError("invalid_json", "Expected a JSON request.", 400);
      return c.json({ request: await service.send(c.req.param("nodeId"), body, kind) });
    });
  }
  return router;
}
