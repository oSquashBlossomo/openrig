import { useState } from "react";
import { useFleet, useSend, type SeatNode } from "../api.js";
import { contextPercent, seatStatusLabel, seatTone, sessionParts, timeAgo } from "../model.js";
import { Dot, Empty, Link, Pill, Ring } from "../components/bits.js";
import { SeatTerminal } from "../components/Terminal.js";

function Facts({ n }: { n: SeatNode }) {
  const rows: [string, string | null | undefined][] = [
    ["runtime", n.runtime],
    ["model", n.model],
    ["effort", n.effort],
    ["status", seatStatusLabel(n)],
    ["startup", n.startupStatus],
    ["lifecycle", n.lifecycleState],
    ["identity", n.identityVerdict?.verdict],
    ["last activity", n.lastActivityAt ? `${timeAgo(n.lastActivityAt)} ago` : null],
    ["cwd", n.cwd],
  ];
  return (
    <dl className="facts">
      {rows.filter(([, v]) => v).map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
    </dl>
  );
}

function Composer({ session }: { session: string }) {
  const [text, setText] = useState("");
  const send = useSend();
  const result = send.data;
  const submit = () => {
    const body = text.trim();
    if (!body || send.isPending) return;
    send.mutate({ session, text: body }, { onSuccess: (r) => { if (r.sent || r.ok) setText(""); } });
  };
  const failed = send.isError || (result && !(result.sent || result.ok));
  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); }}
        placeholder={`Message ${session} (⌘⏎ to send)`}
        rows={3}
      />
      <div className="composer-row">
        <button type="button" className="primary" onClick={submit} disabled={send.isPending || !text.trim()}>
          {send.isPending ? "Sending…" : "Send"}
        </button>
        {send.isError && <span className="note note-bad">{(send.error as Error).message}</span>}
        {result && !send.isError && (
          <span className={`note ${failed ? "note-bad" : "note-ok"}`}>
            {failed ? `Not sent: ${result.reason ?? result.error ?? result.outcome ?? "refused"}` : `Sent${result.verified ? " and verified" : ""}${result.outcome ? ` · ${result.outcome}` : ""}`}
          </span>
        )}
      </div>
    </div>
  );
}

export function SeatPage({ session, hostId }: { session: string; hostId: string }) {
  const fleet = useFleet(hostId);
  const { member, rig } = sessionParts(session);
  const node = [...fleet.byRig.values()].flat().find((n) => n.canonicalSessionName === session);
  const [showFacts, setShowFacts] = useState(false);
  const local = hostId === "local";
  return (
    <div className="page page-seat">
      <header className="seat-head">
        <Link href="/" className="back">‹ Fleet</Link>
        <div className="seat-title">
          {node && <Dot tone={seatTone(node)} title={seatStatusLabel(node)} />}
          <h2>{member}<span className="muted">@{rig}</span></h2>
          {node && <Pill tone={seatTone(node)}>{seatStatusLabel(node)}</Pill>}
          {node && (node.activityState?.needsInput.count ?? 0) > 0 && <Pill tone="warn">needs input</Pill>}
        </div>
        <div className="seat-tools">
          {node && <Ring percent={contextPercent(node)} />}
          <button type="button" className="linkish" onClick={() => setShowFacts(!showFacts)}>{showFacts ? "hide details" : "details"}</button>
        </div>
      </header>
      {!node && !fleet.isLoading && !fleet.nodesPending && <Empty>No seat named {session} on this host.</Empty>}
      {node?.latestError && <div className="note note-bad">{node.latestError}</div>}
      {node?.recoveryGuidance && <div className="note note-warn">{node.recoveryGuidance}</div>}
      {showFacts && node && <Facts n={node} />}
      {local ? (
        <>
          <SeatTerminal session={session} />
          <Composer session={session} />
        </>
      ) : (
        <Empty>Terminals and sends are served by the local daemon only. Switch the host to local to interact with a seat here.</Empty>
      )}
    </div>
  );
}
