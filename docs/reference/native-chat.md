# Native agent chat

Chat shows the selected Claude Code or Codex seat's conversation and lets you send a message to its existing native session. Open it from a seat, Graph or 3D. **Terminal** remains available beside Chat for native commands, permission requests, questions, login and recovery.

Messages and tool records come from the native conversation saved on the host. The view refreshes while open; it does not invoke a model to load history. Replies appear as the native CLI saves them, rather than necessarily one token at a time. Older history loads in bounded pages. Unsupported or incomplete history is identified in the view.

Send is available only when the current seat and native conversation can be verified and its composer is ready. Ordinary single-line paragraphs may wrap visually. Multiline input, collapsed pastes and unsupported native editor layouts use Terminal; the terminal screen is a guarded visual projection, not a native message-acknowledgement protocol. A busy seat, existing terminal draft or native prompt may require Terminal. Opening Chat does not start, resume or replace an agent, change its permissions or switch its subscription to API billing.

Delivery states distinguish submission from a recorded native message. If the connection drops or an operation has an uncertain outcome, inspect the conversation or Terminal before sending again. Reconnecting never replays input automatically. Drafts stay with their conversation across navigation in the current page; closing or reloading the page clears drafts held in browser memory.

## Native slash commands

Chat never sends a slash command as a message. A single-line draft that starts with `/` offers **Open native command**. OpenRig has no list of allowed commands and does not parse or emulate them: the native CLI handles any command it has installed, including built-in commands, custom commands, skills and plugin commands, with arguments and Unicode exactly as typed.

1. **Open native command** re-reads the seat's native identity, bypassing the browser's HTTP cache. It continues only if the node, session (name and id), conversation and owner are the ones Chat showed. It then opens the same seat's Terminal with the command in a local box. Opening, switching views, reconnecting or reloading sends nothing to the agent.
2. **Paste command** checks the same identity again, then types the text into the agent's input as one literal paste, without Enter. The Terminal's usual connection, admission and input checks still apply.
3. You run the command in the Terminal: press Enter and use the agent's own menus, pickers and confirmations, as you would in the CLI.

OpenRig reports only that the paste was sent; it does not know whether the command ran or what it did. The Chat draft stays until you clear it, so you can return to it. A command is handed off once, to the seat it was opened for: switching to another seat drops it, and a remount or reconnect never pastes it again. If the session, conversation (for example after `/clear` or a restart) or owner changed, nothing is pasted and the reason is shown; open the command again from Chat or use the Terminal directly. Chat's own readiness does not block the paste: Chat Send stays off while the agent is busy or showing a native menu, but you can see the Terminal and decide when to paste and press Enter. Commands with line breaks, tabs or other control characters are not handed off; type them in the Terminal. The identity check is a fresh read just before the paste, not a lock held by the daemon while the input arrives, so look at the Terminal before pressing Enter.

OpenRig's rig coordination chat is separate from this native conversation view. Native approval and question controls remain in Terminal in this version.
