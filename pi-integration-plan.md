# Pi.dev Integration Plan

Integrate the [pi coding agent](https://pi.dev) (npm: [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent), v0.73.0, MIT, 11.2 MB unpacked) as a new chat session type. The VS Code chat panel becomes a frontend for the pi agent.

The integration mirrors `src/extension/chatSessions/claude/`, but the Claude integration is **~4,025 LOC across 3 sub-trees** (`common/`, `node/`, `vscode-node/`). A like-for-like pi integration would be similar in size; this plan instead delivers a **leaner subset** in phases and explicitly defers Claude-only features (tool permission UI, MCP gateway, hooks, slash commands, session disk persistence) until they're proven needed.

---

## Phase 0 — Verify SDK shape (1–2 hrs, blocking)

The original plan assumed the pi SDK API surface from the README. Before writing wiring code we need to confirm, in a scratch script:

1. The exact named export(s) used to create a session (the plan assumed `createAgentSession` — verify).
2. Whether the SDK ships a `session.abort()` / `AbortController` cancellation hook (Decision 3).
3. The event shape for streaming tokens, tool start/end, and end-of-turn.
4. Whether `AuthStorage.create()` is the public auth entry point.
5. **Bundle health**: what `webpack`/`esbuild` does with `@mariozechner/pi-tui` and `@silvia-odwyer/photon-node` when imported from extension code. The TUI dep is irrelevant at runtime in VS Code; if it can't be tree-shaken cleanly, that pushes us toward Decision 1 option B (RPC).

**Output**: a one-page note appended to this plan with the actual API names, cancellation answer, and bundle delta in MB. Implementation does not start until this exists.

---

## Phase 1 — MVP (target: ~600 LOC, 1–2 days)

Goal: a working `pi-agent` chat session that streams text, supports cancellation, and persists conversation memory across turns within a single VS Code session. Behind a feature flag, hidden by default.

### Files to create

| File | Approx LOC | Purpose |
|---|---|---|
| `src/extension/chatSessions/pi/common/piSessionUri.ts` | ~25 | URI scheme constant + `forSessionId(id)` helper, mirrors `claudeSessionUri.ts` |
| `src/extension/chatSessions/pi/node/piSdkService.ts` | ~80 | DI wrapper around the npm package. Lazy-imports the SDK so extension activation cost stays near zero. Mirrors `claudeCodeSdkService.ts:66-108` (the dynamic-import pattern). |
| `src/extension/chatSessions/pi/node/piCodeAgent.ts` | ~350 | `PiAgentManager` (one per extension) holding `Map<sessionId, PiCodeSession>`; `PiCodeSession` owns the SDK session, maps SDK events → `vscode.ChatResponseStream`, handles cancellation. |
| `src/extension/chatSessions/pi/node/piHistoryReplay.ts` | ~80 | When VS Code rehydrates a session (e.g. window reload), the SDK session object is gone. This module replays `vscode.ChatRequest.history` into the new SDK session so context is preserved. Equivalent of Claude's `chatHistoryBuilder.ts`. **The original plan missed this entirely.** |
| `src/extension/chatSessions/vscode-node/piChatSessionContentProvider.ts` | ~150 | Implements `vscode.ChatSessionContentProvider`, creates the request handler that bridges VS Code → `PiAgentManager`. No permission-mode UI in MVP (pi auto-mode only). |

### Files to modify

**`src/extension/chatSessions/vscode-node/chatSessions.ts`**

Add a Pi block after the Claude block (line 154). Pattern:

```typescript
// #region Pi Chat Sessions
const piInstaService = instantiationService.createChild(new ServiceCollection(
    [IPiSdkService, new SyncDescriptor(PiSdkService)],
));
const piAgentManager = this._register(piInstaService.createInstance(PiAgentManager));
const piContentProvider = this._register(piInstaService.createInstance(
    PiChatSessionContentProvider, piAgentManager));
const piParticipant = vscode.chat.createChatParticipant(
    PiSessionUri.scheme, piContentProvider.createHandler());
piParticipant.iconPath = new vscode.ThemeIcon('pi'); // requires icon contribution, see below
this._register(vscode.chat.registerChatSessionContentProvider(
    PiSessionUri.scheme, piContentProvider, piParticipant));
// #endregion
```

**`package.json`**

1. Add `"@mariozechner/pi-coding-agent": "^0.73.0"` to `dependencies`. (Phase 0 must confirm bundle is acceptable; if not, switch to Decision 1 option B and add nothing here.)
2. Add a `chatSessions` entry after the `claude-code` entry (line 6008). Required fields the original plan missed: `welcomeTitle`, `welcomeMessage`, `inputPlaceholder`, `order`, `description`, `capabilities.supportsFileAttachments` (file context yes), `supportsImageAttachments` (defer to Phase 2 — pi's image handling needs validation):
   ```json
   {
     "type": "pi-agent",
     "name": "pi",
     "displayName": "Pi",
     "icon": "$(pi)",
     "welcomeTitle": "Pi Agent",
     "welcomeMessage": "Powered by the pi coding agent (pi.dev)",
     "inputPlaceholder": "Run local tasks with Pi, type `#` for adding context",
     "order": 4,
     "when": "config.github.copilot.chat.piAgent.enabled",
     "canDelegate": false,
     "requiresCustomModels": false,
     "capabilities": { "supportsFileAttachments": true, "supportsImageAttachments": false }
   }
   ```
   `requiresCustomModels: false` for MVP. Flip to `true` when Phase 2 model picker lands.
3. Add the `github.copilot.chat.piAgent.enabled` config schema entry (mirror line 3085 for `claudeAgent.enabled`).
4. Add an `icons` contribution for `$(pi)` — VS Code does not auto-provide this; the plan needs an SVG/font glyph or fallback to a built-in codicon like `$(robot)`. Defaulting to `$(robot)` for MVP avoids the icon-font work.
5. Add l10n keys for the description string.

### Out of scope for Phase 1 (explicit non-goals)

- Model picker integration (Decision 4 option C) — pi uses its own configured default
- Session listing / disk persistence across VS Code restarts
- Slash commands (`/init`, `/review`, etc.)
- Tool permission UI (auto-approve in MVP — see Decision 6)
- MCP servers, hooks, customization provider
- Multi-root workspace folder picker (use first workspace folder)
- Image attachments
- Custom icon (use `$(robot)`)

---

## Phase 2 — Model picker (Decision 4 option C, ~1,000 LOC, 2–3 days)

The user requested Option C: register pi models via `vscode.lm.registerChatModelProvider` so they appear in the standard VS Code model picker. This is **the largest single piece of work** in the integration and was budgeted at zero in the original plan.

The Claude analog spans:

- `src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts` — 751 LOC (proxy server bridging VS Code's LM API ↔ SDK)
- `src/extension/chatSessions/claude/node/claudeCodeModels.ts` — 280 LOC (model enumeration + provider registration)

For pi we need equivalents that:

1. Enumerate pi's 15+ provider/model combinations (likely from the SDK; otherwise hardcode the curated list).
2. Register each as a `LanguageModelChatProvider`.
3. When the user picks a pi model in the picker for a pi session, route requests through the SDK with that model selected.

Flip `requiresCustomModels: true` in the package.json entry once this lands.

---

## Phase 3 — Optional enrichments (prioritise based on user feedback)

- Disk session persistence + session list provider (item provider, not just content provider)
- Tool event display upgrade (Decision 6 option C — full tool blocks via `stream.toolCall`/`stream.toolResult` if the API supports it for custom session types; option B progress messages ship in Phase 1)
- Slash commands (mirror `claudeSlashCommandService.ts`)
- Customization provider (`vscode.chat.registerChatSessionCustomizationProvider`) for per-session settings UI
- Multi-root folder picker
- Image attachments
- Custom icon contribution

---

## Decisions — updated

| # | Decision | Original recommendation | Updated answer | Status |
|---|---|---|---|---|
| 1 | SDK bundle vs. spawn `pi --mode rpc` | A (SDK), with caveat "if >5 MB, prefer RPC" | **Pending Phase 0**. Pi npm is 11.2 MB unpacked + native deps (`photon-node`) + a TUI dep that's dead weight in extension context. SDK is still preferred *if* esbuild can drop the TUI cleanly; otherwise switch to RPC. | **BLOCKING — resolves in Phase 0** |
| 2 | Auth | A (let pi handle it) | **Both, in order**: read VS Code SecretStorage first (key `github.copilot.pi.apiKey`); fall back to `AuthStorage.create()` (pi's `~/.pi/`). Matches user's "offer both paths" call. ~15 LOC delta vs. A. | Resolved |
| 3 | Cancellation | Verify on install | Phase 0 confirms the SDK API. If neither `session.abort()` nor `AbortController` exists, MVP ships option C (stop consuming events) and we file an upstream issue. | Resolves in Phase 0 |
| 4 | Model selection | B (string setting) | **C (model picker)**, per user. **Deferred to Phase 2** — flagged as a major effort the original plan didn't budget. Phase 1 ships with pi's configured default. | Resolved, scoped |
| 5 | Session persistence across turns | A (persistent) | A confirmed. Phase 1 keeps the SDK session in memory; Phase 3 adds disk persistence if needed. | Resolved |
| 6 | Tool event display | B (progress messages) | B confirmed for Phase 1. Phase 3 may upgrade to C (full tool blocks) once we see what pi emits. | Resolved |
| 7 | Feature flag | B (hidden by default) | B confirmed. Setting: `github.copilot.chat.piAgent.enabled`, default `false`. | Resolved |

---

## Effort summary

| Phase | LOC | Time | Ships |
|---|---|---|---|
| 0 — Verify SDK | ~50 (throwaway) | 1–2 hrs | A note appended to this plan |
| 1 — MVP | ~600 | 1–2 days | Working `pi-agent` chat session, text + cancellation + in-memory persistence, behind flag |
| 2 — Model picker | ~1,000 | 2–3 days | Pi models in VS Code model picker |
| 3 — Enrichments | varies | Demand-driven | Slash commands, disk persistence, tool blocks, etc. |

**Original plan claimed 540 LOC / 4–6 hrs for what amounted to Phases 1+2.** That estimate was off by roughly a factor of 5 because it (a) under-counted the content provider and agent files by comparing to imagined sizes rather than the actual Claude analogs, and (b) didn't budget the model picker at all.

---

## Risks not in the original plan

1. **Bundle bloat / native deps**. `photon-node` is a native module; it may not load under VS Code's extension host without rebuild. Phase 0 must verify.
2. **TUI dependency leakage**. `@mariozechner/pi-tui` will pull in terminal-rendering code that's unreachable in extension context but may still be bundled. Esbuild config may need a manual external/no-op shim.
3. **Pi SDK is young (v0.73.0, 22 hrs since last publish at time of writing)**. API churn risk. Pin to exact version for MVP, not a caret range.
4. **Auth UX collision**. If a user has both a VS Code secret and a `~/.pi/` config, the order of precedence (Decision 2) needs to be visible somewhere — either a settings description string or a status-bar indicator. Defer to Phase 3.
5. **No `canDelegate` story**. Claude sets `canDelegate: true`; we don't know what pi does on delegation. MVP sets `false` to avoid promising something we haven't tested.
