import { afterEach, expect, it, vi } from "vitest";
import { createBrowserUuid } from "../src/lib/browser-uuid.js";

afterEach(() => vi.unstubAllGlobals());

it("formats random bytes as a version-4 UUID without crypto.randomUUID", () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(255));
  vi.stubGlobal("crypto", { getRandomValues });
  expect(createBrowserUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  expect(getRandomValues).toHaveBeenCalledTimes(1);
});
