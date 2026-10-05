// Route-level binding for the seat startup chooser. Uses only already-declared
// exact destinations: the seat scope page for native-session inspection and the
// rig page for the unchanged bulk Launch/Restore actions.

import { useNavigate } from "@tanstack/react-router";
import { StartupChooser } from "./StartupChooser.js";

export function StartupPage() {
  const navigate = useNavigate();
  return (
    <StartupChooser
      onInspectSeat={({ rigId, logicalId }) => void navigate({ to: "/topology/seat/$rigId/$logicalId", params: { rigId, logicalId } })}
      onOpenRig={rigId => void navigate({ to: "/rigs/$rigId", params: { rigId } })}
    />
  );
}
