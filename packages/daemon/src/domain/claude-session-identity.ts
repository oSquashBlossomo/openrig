import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listNativeProcesses,
  observeClaudePaneProcess,
  observeClaudePaneRuntime,
  type NativeProcessObservation,
  type NativeProcessRow,
  type NativeProcessLister,
} from "./native-process-lineage.js";
import { validateResumeToken } from "./resume-token-validation.js";

/** Claude rewrites this PID-scoped record when /clear changes the conversation.
 * A same-name record from another process or an earlier use of this PID is not evidence. */
export function readClaudeProcessSession(input: {
  process: NativeProcessRow;
  sessionName: string;
  configDir: string;
}): string | undefined {
  try {
    const started = Date.parse(input.process.startedAt ?? "");
    if (!Number.isFinite(started)) return undefined;
    const fd = fs.openSync(path.join(input.configDir, "sessions", `${input.process.pid}.json`), "r");
    let record: { name?: unknown; sessionId?: unknown };
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 || stat.mtimeMs < started) return undefined;
      record = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
    if (record?.name !== input.sessionName) return undefined;
    const valid = validateResumeToken("claude-code", record.sessionId);
    return valid.ok ? valid.token : undefined;
  } catch { return undefined; }
}

type CurrentSessionInput = Parameters<typeof observeClaudePaneProcess>[0] & {
  sessionName: string;
  cwd?: string | null;
};

/** One current-session observation. Launch argv remains the fast path; after
 * /clear, only an exact current PID record can witness the saved hook identity.
 * This is not proof that a particular restore attempt resumed its launch token. */
export async function observeClaudeCurrentSession(input: CurrentSessionInput): Promise<NativeProcessObservation | null> {
  if (!input.expectedToken) return null;
  let snapshot: ReturnType<NativeProcessLister> | undefined;
  const observation = { ...input, listProcesses: () => snapshot ??= (input.listProcesses ?? listNativeProcesses)() };
  const launched = await observeClaudePaneProcess(observation);
  if (launched) return launched;
  const current = await observeClaudePaneRuntime(observation);
  if (!current) return null;
  const configDir = path.resolve(input.cwd ?? process.cwd(), process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
  return readClaudeProcessSession({ process: current.process, sessionName: input.sessionName, configDir }) === input.expectedToken
    ? current : null;
}

export async function verifyClaudeCurrentSession(input: CurrentSessionInput): Promise<NativeProcessObservation | null> {
  const first = await observeClaudeCurrentSession(input);
  if (!first) return null;
  const second = await observeClaudeCurrentSession(input);
  return second?.fingerprint === first.fingerprint ? second : null;
}
