import Database from "better-sqlite3";
import { lstartToMinTs, resolveCodexDbPaths } from "./codex-thread-id.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const creation = new RegExp(`^app_server\\.request\\{([^{}]+)\\}:app_server\\.thread_start\\.create_thread\\{[^{}]*\\}:thread_spawn\\{[^{}]*\\}:session_init:environments\\.resolve\\{[^{}]*\\}:shell_snapshot\\{thread_id=(${UUID})\\}: Shell snapshot successfully created: `, "i");

/** Chat-only current-thread evidence before Codex persists its first rollout.
 * This is NOT resume eligibility and must never populate resume metadata.
 * The caller sandwiches two reads between stable native process observations.
 * A generic PID-owned UUID is insufficient: title-generation threads share it. */
export function readFreshCodexChatThread(pid: number, startedAt: string | undefined, codexHome: string): string | undefined {
  const minTs = lstartToMinTs(startedAt);
  if (minTs === undefined || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const identities = new Set<string>();
  const paths = resolveCodexDbPaths("", "logs", undefined, codexHome);
  if (!paths.length || paths.length > 4) return undefined;
  for (const path of paths) {
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      const rows = db.prepare("SELECT thread_id,process_uuid,substr(feedback_log_body,1,8193) AS body FROM logs WHERE process_uuid LIKE ? AND ts > ? AND target='codex_core::shell_snapshot' AND thread_id IS NOT NULL LIMIT 65")
        .all(`pid:${pid}:%`, minTs) as Array<{ thread_id: string; process_uuid: string; body: string }>;
      if (rows.length > 64) return undefined;
      for (const row of rows) {
        const match = typeof row.body === "string" && row.body.length <= 8192 ? creation.exec(row.body) : null;
        if (!match || match[2] !== row.thread_id
          || !/(?:^| )rpc\.method="thread\/start"(?: |$)/.test(match[1]!)
          || !/(?:^| )rpc\.transport="in-process"(?: |$)/.test(match[1]!)
          || !/(?:^| )app_server\.client_name="codex-tui"(?: |$)/.test(match[1]!)
          || !new RegExp(`^pid:${pid}:${UUID}$`, "i").test(row.process_uuid)) continue;
        identities.add(`${row.process_uuid}|${row.thread_id}`);
      }
    } catch { return undefined; } finally { db?.close(); }
  }
  return identities.size === 1 ? [...identities][0]!.split("|")[1] : undefined;
}
