import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Launch assertions must not read the developer's native permission default.
// Import before test declarations whose baseline is captured at module load.
const original = process.env.CLAUDE_CONFIG_DIR;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-claude-test-"));
process.env.CLAUDE_CONFIG_DIR = directory;
afterAll(() => {
  if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = original;
  fs.rmSync(directory, { recursive: true, force: true });
});
