// xterm emits raw bytes; the daemon's terminal broker takes tmux key names.
export type WsMessage = { type: "keys"; keys: string[] } | { type: "text"; text: string };

const SPECIAL: Record<string, string> = {
  "\r": "Enter",
  "\n": "Enter",
  "\t": "Tab",
  "\x7f": "BSpace",
  "\x08": "BSpace",
  "\x1b": "Escape",
  "\x03": "C-c",
  "\x04": "C-d",
  "\x1a": "C-z",
  "\x0c": "C-l",
  "\x01": "C-a",
  "\x05": "C-e",
  "\x0b": "C-k",
  "\x15": "C-u",
  "\x17": "C-w",
};

const ESCAPES: Record<string, string> = {
  "\x1b[A": "Up",
  "\x1b[B": "Down",
  "\x1b[C": "Right",
  "\x1b[D": "Left",
  "\x1b[H": "Home",
  "\x1b[F": "End",
  "\x1b[5~": "PgUp",
  "\x1b[6~": "PgDn",
  "\x1b[3~": "DC",
  "\x1b[2~": "IC",
};

export function mapXtermInput(data: string): WsMessage[] {
  const out: WsMessage[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ type: "text", text }); text = ""; } };
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const esc = Object.keys(ESCAPES).find((seq) => rest.startsWith(seq));
    if (esc) { flush(); out.push({ type: "keys", keys: [ESCAPES[esc]!] }); i += esc.length; continue; }
    const key = SPECIAL[data[i]!];
    if (key) { flush(); out.push({ type: "keys", keys: [key] }); i++; continue; }
    text += data[i]!;
    i++;
  }
  flush();
  return out;
}

/** The on-screen keys a touch keyboard lacks. */
export const KEY_BAR: { label: string; key: string }[] = [
  { label: "esc", key: "Escape" },
  { label: "tab", key: "Tab" },
  { label: "↑", key: "Up" },
  { label: "↓", key: "Down" },
  { label: "←", key: "Left" },
  { label: "→", key: "Right" },
  { label: "^C", key: "C-c" },
  { label: "⏎", key: "Enter" },
];
