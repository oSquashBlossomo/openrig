import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Claude statusline cache collection", () => {
  it("retains only cache facts, observed model/version and existing context data", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-collector-"));
    try {
      const output = join(root, "sample.json");
      execFileSync(process.execPath, [new URL("../assets/claude-statusline-context.cjs", import.meta.url).pathname, output], {
        input: JSON.stringify({ context_window: { used_percentage: 1, current_usage: { input_tokens: 100 } }, session_id: "native-id", version: "2.1.293", model: { id: "claude-opus-5-5", private: "PRIVATE" }, prompt_cache: { warm: true, ttl: "1h", requests: 2, last_miss_cause: { causes: ["tools_changed", "PRIVATE"], tools_added: 1, prompt: "PRIVATE" }, miss_causes: { tools_changed: 1, PRIVATE: 99 }, prompt: "PRIVATE" }, prompt: "PRIVATE", credentials: "PRIVATE" }),
        env: { PATH: process.env.PATH },
      });
      const raw = JSON.parse(readFileSync(output, "utf8"));
      expect(raw.cache_metadata).toEqual({ runtime_version: "2.1.293", model_id: "claude-opus-5-5", prompt_cache: { warm: true, ttl: "1h", requests: 2, last_miss_cause: { causes: ["tools_changed"], tools_added: 1 }, miss_causes: { tools_changed: 1 } } });
      expect(raw.context_window.current_usage).toEqual({ input_tokens: 100 });
      expect(readFileSync(output, "utf8")).not.toContain("PRIVATE");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
