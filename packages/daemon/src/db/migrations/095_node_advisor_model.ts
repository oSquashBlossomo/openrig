import type { Migration } from "../migrate.js";

// Session-local Claude advisor selection. NULL inherits native defaults; "off" disables it.
export const nodeAdvisorModelSchema: Migration = {
  name: "095_node_advisor_model.sql",
  sql: "ALTER TABLE nodes ADD COLUMN advisor_model TEXT;",
};
