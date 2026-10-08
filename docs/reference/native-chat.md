# Native agent chat

Chat shows the selected Claude Code or Codex seat's conversation and lets you send a message to its existing native session. Open it from a seat, Graph or 3D. **Terminal** remains available beside Chat for native commands, permission requests, questions, login and recovery.

Messages and tool records come from the native conversation saved on the host. The view refreshes while open; it does not invoke a model to load history. Replies appear as the native CLI saves them, rather than necessarily one token at a time. Older history loads in bounded pages. Unsupported or incomplete history is identified in the view.

Send is available only when the current seat and native conversation can be verified and its composer is ready. Ordinary single-line paragraphs may wrap visually. Multiline input, collapsed pastes and unsupported native editor layouts use Terminal; the terminal screen is a guarded visual projection, not a native message-acknowledgement protocol. A busy seat, existing terminal draft or native prompt may require Terminal. Opening Chat does not start, resume or replace an agent, change its permissions or switch its subscription to API billing.

Delivery states distinguish submission from a recorded native message. If the connection drops or an operation has an uncertain outcome, inspect the conversation or Terminal before sending again. Reconnecting never replays input automatically. Drafts stay with their conversation across navigation in the current page; closing or reloading the page clears drafts held in browser memory.

OpenRig's rig coordination chat is separate from this native conversation view. Native approval and question controls remain in Terminal in this version.
