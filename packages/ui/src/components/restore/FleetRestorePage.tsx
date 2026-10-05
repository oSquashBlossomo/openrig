// Route-level binding for connected fleet restore. Attention rows carry the
// exact served rig ID and logical seat ID, which address the existing seat page.

import { useNavigate } from "@tanstack/react-router";
import { FleetRestorePanel } from "./FleetRestorePanel.js";

export function FleetRestorePage() {
  const navigate = useNavigate();
  return (
    <FleetRestorePanel
      onInspectSeat={({ rigId, seat }) => void navigate({ to: "/topology/seat/$rigId/$logicalId", params: { rigId, logicalId: seat } })}
      onOpenRig={rigId => void navigate({ to: "/rigs/$rigId", params: { rigId } })}
    />
  );
}
