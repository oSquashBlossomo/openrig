import type { Migration } from "../migrate.js";

/** Durable at-most-once terminal dispatch receipts; never prune UUIDs into replay eligibility. */
export const nativeChatRequestsSchema: Migration = {
  name: "096_native_chat_requests.sql",
  sql: `CREATE TABLE native_chat_requests (
    request_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('message','interrupt')),
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('sending','submitted','observed','failed','indeterminate')),
    detail TEXT NOT NULL,
    effects_started INTEGER NOT NULL DEFAULT 0 CHECK(effects_started IN (0,1)),
    file_key TEXT,
    history_offset INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX native_chat_requests_node ON native_chat_requests(node_id, conversation_id, created_at);`,
};
