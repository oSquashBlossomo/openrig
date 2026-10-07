import type Database from "better-sqlite3";
import type { NodeBinding } from "./runtime-adapter.js";
import { permissionBindingOverride, type NativePermissionSelection } from "./native-permission-selection.js";
import { builtinLaunchPosture, validatePermissionPolicyRef } from "./permission-policy/policy-ref.js";

export interface StoredNativePermissionSelection extends NativePermissionSelection {
  actor: string;
  reason: string;
  updatedAt: string;
}

export type PermissionModeSource = "explicit" | "member_spec" | "rig_spec" | "kernel_default" | "system_default";

export interface ResolvedSeatPermission {
  /** "inherit" leaves the native mode unverified; it is not an observed launch effect. */
  effectiveMode: string;
  source: PermissionModeSource;
  launchPosture?: "floor" | "full_bypass" | "auto";
  permissionMode?: string;
  fallbackReason?: string;
}

/** The stable node owns the desired setting. Native history and current processes are untouched. */
export class NativePermissionStore {
  constructor(private readonly db: Database.Database) {}

  /** One decision shared by fresh/continue, legacy restore and same-seat handover. */
  launchOverride(nodeId: string, runtime: string, resolvedPosture?: NodeBinding["launchPosture"]): Pick<NodeBinding, "launchPosture" | "permissionMode" | "kernelAuthority" | "claudePermissionFloor"> {
    const selection = this.read(nodeId);
    if (selection && selection.runtime !== runtime) {
      throw new Error("Seat runtime changed since permission selection; explicitly select again or inherit.");
    }
    // A rig name is not an opt-in permission choice. Clear stale internal grants
    // and preserve native settings/profile inheritance unless explicitly selected.
    if (!selection && runtime === "claude-code") {
      // Lifecycle bindings also use floor for honest absence, to suppress ambient
      // YOLO. Only an authored policy selects the static floor. Use the caller's
      // current posture: restore may have re-derived a changed custom policy.
      const row = this.db.prepare(`SELECT n.permission_policy AS memberRef, r.permission_policy AS rigRef,
        COALESCE(n.policy_origin, r.rig_policy_origin) AS origin
        FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?`).get(nodeId) as {
          memberRef: string | null; rigRef: string | null; origin: string | null;
        } | undefined;
      // 055/056 refs can predate 057/058 provenance, which was not backfilled.
      // A raw member none still masks the rig. Never resolve relative files here.
      const ref = row?.memberRef ?? row?.rigRef;
      if (ref != null) {
        const error = validatePermissionPolicyRef(ref, "Stored permission policy");
        if (error) throw new Error(error);
      }
      // Older none rows can reach this boundary with the rig fallback posture.
      // The literal choice is still inheritance and masks that fallback.
      if (ref === "none") return { kernelAuthority: false, claudePermissionFloor: false, launchPosture: "floor" };
      if (resolvedPosture === "floor" && (ref != null || row?.origin === "builtin" || row?.origin === "custom")) {
        return { kernelAuthority: false, claudePermissionFloor: true };
      }
    }
    return { kernelAuthority: false, claudePermissionFloor: false, ...permissionBindingOverride(selection) };
  }

  read(nodeId: string): StoredNativePermissionSelection | null {
    const row = this.db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").get(nodeId) as {
      runtime: string; mode: string; actor: string; reason: string; updated_at: string;
    } | undefined;
    if (!row) return null;
    if ((row.runtime !== "codex" && row.runtime !== "claude-code") || !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.mode)
      || (row.runtime === "codex" && row.mode !== "floor" && row.mode !== "full_bypass")) {
      throw new Error("Invalid persisted native permission selection; launch refused.");
    }
    return { runtime: row.runtime, mode: row.mode, actor: row.actor, reason: row.reason, updatedAt: row.updated_at };
  }

  write(nodeId: string, selection: NativePermissionSelection | null, actor: string, reason: string): void {
    if (!selection) {
      this.db.prepare("DELETE FROM node_permission_selections WHERE node_id = ?").run(nodeId);
      return;
    }
    this.db.prepare(`INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(node_id) DO UPDATE SET runtime=excluded.runtime, mode=excluded.mode,
        actor=excluded.actor, reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(nodeId, selection.runtime, selection.mode, actor, reason);
  }

  resolve(nodeId: string, runtime: string): ResolvedSeatPermission {
    // Level 1: Explicit per-seat selection (records actor + reason, overrides member and rig)
    const explicit = this.read(nodeId);
    if (explicit) {
      if (explicit.runtime !== runtime) {
        throw new Error("Seat runtime changed since permission selection; explicitly select again or inherit.");
      }
      return {
        effectiveMode: explicit.mode,
        source: "explicit",
        ...(explicit.mode === "floor" || explicit.mode === "full_bypass"
          ? { launchPosture: explicit.mode }
          : {}),
        ...(explicit.mode !== "floor" && explicit.mode !== "full_bypass"
          ? { permissionMode: explicit.mode }
          : {}),
      };
    }

    // Query node for member-level policy, resolved posture, and rig_id
    let memberPolicy: string | null = null;
    let nodePosture: string | null = null;
    let rigId: string | null = null;
    let rigPolicy: string | null = null;
    let rigPosture: string | null = null;

    try {
      const nodeRow = this.db.prepare(
        "SELECT permission_policy, policy_launch_posture, rig_id FROM nodes WHERE id = ?"
      ).get(nodeId) as {
        permission_policy?: string | null;
        policy_launch_posture?: string | null;
        rig_id?: string | null;
      } | undefined;

      if (nodeRow) {
        memberPolicy = nodeRow.permission_policy ?? null;
        nodePosture = nodeRow.policy_launch_posture ?? null;
        rigId = nodeRow.rig_id ?? null;
      }

      if (rigId) {
        const rigRow = this.db.prepare(
          "SELECT permission_policy, rig_policy_launch_posture FROM rigs WHERE id = ?"
        ).get(rigId) as {
          permission_policy?: string | null;
          rig_policy_launch_posture?: string | null;
        } | undefined;

        if (rigRow) {
          rigPolicy = rigRow.permission_policy ?? null;
          rigPosture = rigRow.rig_policy_launch_posture ?? null;
        }
      }
    } catch {
      // Table or column might be missing in minimal/legacy test environments
    }

    // Level 2: Member-level declaration in rig.yaml
    // Precedence: member's own declaration must never be silently outranked by a rig-wide default.
    if (memberPolicy !== null) {
      const effectivePosture = runtime === "claude-code" && memberPolicy === "none" ? "floor" : nodePosture ?? builtinLaunchPosture(memberPolicy);

      if (effectivePosture === "auto") {
        if (runtime !== "claude-code") {
          const runtimeName = runtime === "codex" ? "Codex" : runtime === "pi" ? "Pi" : runtime;
          return {
            effectiveMode: "floor",
            source: "member_spec",
            launchPosture: "floor",
            fallbackReason: `${runtimeName} has no auto mode and launches at the floor`,
          };
        }
        return {
          effectiveMode: "auto",
          source: "member_spec",
          launchPosture: "auto",
          permissionMode: "auto",
        };
      }

      if (effectivePosture === "full_bypass") {
        return {
          effectiveMode: "full_bypass",
          source: "member_spec",
          launchPosture: "full_bypass",
        };
      }

      // effectivePosture === "floor" (e.g. builtin:locked, none, or custom floor policy)
      return this.floorStatus(nodeId, runtime, "member_spec");
    }

    // Level 3: Rig-level declaration in rig.yaml
    // Applied when the member did not declare its own policy.
    const effectiveRigPosture = rigPosture ?? (
      rigPolicy !== null ? builtinLaunchPosture(rigPolicy)
      : (nodePosture && nodePosture !== "floor" ? nodePosture : null)
    );

    if (rigPolicy !== null || effectiveRigPosture !== null) {
      const posture = runtime === "claude-code" && rigPolicy === "none" ? "floor" : effectiveRigPosture ?? "floor";

      if (posture === "auto") {
        if (runtime !== "claude-code") {
          const runtimeName = runtime === "codex" ? "Codex" : runtime === "pi" ? "Pi" : runtime;
          return {
            effectiveMode: "floor",
            source: "rig_spec",
            launchPosture: "floor",
            fallbackReason: `${runtimeName} has no auto mode and launches at the floor`,
          };
        }
        return {
          effectiveMode: "auto",
          source: "rig_spec",
          launchPosture: "auto",
          permissionMode: "auto",
        };
      }

      if (posture === "full_bypass") {
        return {
          effectiveMode: "full_bypass",
          source: "rig_spec",
          launchPosture: "full_bypass",
        };
      }

      // posture === "floor" (e.g. builtin:locked, none)
      return this.floorStatus(nodeId, runtime, "rig_spec");
    }

    // Level 4: System default floor
    return this.floorStatus(nodeId, runtime, "system_default");
  }

  private floorStatus(nodeId: string, runtime: string, source: PermissionModeSource): ResolvedSeatPermission {
    // Use the same authored-floor/native-inheritance boundary as launch. Status
    // does not inspect native settings or promote prior argv into effective mode.
    const override = runtime === "claude-code" ? this.launchOverride(nodeId, runtime, "floor") : undefined;
    const inherit = runtime === "claude-code" && !override?.claudePermissionFloor;
    return { effectiveMode: inherit ? "inherit" : runtime === "codex" ? "floor" : "acceptEdits", source, launchPosture: "floor" };
  }

  apply(binding: NodeBinding, runtime: string): NodeBinding {
    const override = this.launchOverride(binding.nodeId, runtime, binding.launchPosture);
    const effectivePosture = override.launchPosture ?? binding.launchPosture;
    const permissionMode = override.permissionMode ?? (effectivePosture === "auto" && runtime === "claude-code" ? "auto" : undefined);
    return {
      ...binding,
      ...override,
      ...(permissionMode ? { permissionMode } : {}),
    };
  }
}
