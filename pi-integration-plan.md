# Pi.dev Integration Plan

Integrating the [pi coding agent](https://pi.dev) ([`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)) as a new chat session type in this extension. The VS Code chat panel becomes a frontend for the pi agent.

## Overview

Add a `pi-agent` chat session type to the extension, backed by the `@mariozechner/pi-coding-agent` npm SDK. Users open a "Pi" session in the Copilot chat panel and interact with the pi agent directly.

The integration mirrors the existing Claude Code integration in `src/extension/chatSessions/claude/` but is significantly leaner because pi handles its own model routing and authentication — no local language model server, no MCP gateway, no permission service required for the MVP.

## Files to Create

### `src/extension/chatSessions/pi/node/piSdkService.ts` (~60 lines)

Thin DI wrapper around the pi npm package. Mirrors `claudeCodeSdkService.ts` exactly. Lazy-loads the SDK on first use so extension startup cost stays zero.

```
IPiSdkService interface + PiSdkService class
  createSession(cwd, apiKey?, modelId?) → AgentSession
```

### `src/extension/chatSessions/pi/node/piCodeAgent.ts` (~300 lines)

The core logic. Two classes:

**`PiAgentManager`** — one per extension lifecycle. Holds a map of `sessionId → PiCodeSession`. Entry point called by the content provider.

**`PiCodeSession`** — one per VS Code chat session. Owns the pi SDK session object. Handles:
- Creating/reusing the pi session across multi-turn chat
- Mapping pi SDK events → `vscode.ChatResponseStream`
- Cancellation
- Tool event display

Event → stream mapping:

| pi event | VS Code stream call |
|----------|-------------------|
| `message_update` (text_delta) | `stream.markdown(delta)` |
| `tool_execution_start` | `stream.progress(toolName)` |
| `tool_execution_end` | (silent, or show result summary) |
| `agent_end` | resolve promise |

### `src/extension/chatSessions/vscode-node/piChatSessions.ts` (~100 lines)

VS Code wiring — mirrors `claudeChatSessionContentProvider.ts`. Implements `vscode.ChatSessionContentProvider`, creates the handler that bridges VS Code's chat request lifecycle to `PiAgentManager`.

## Files to Modify

### `src/extension/chatSessions/vscode-node/chatSessions.ts`

Add a `// #region Pi Chat Sessions` block (20–30 lines) following the exact pattern of the Claude block at line 126:

```typescript
const piInstaService = instantiationService.createChild(new ServiceCollection(
    [IPiSdkService, new SyncDescriptor(PiSdkService)],
));
const piAgentManager = this._register(piInstaService.createInstance(PiAgentManager));
const piContentProvider = this._register(piInstaService.createInstance(PiChatSessionContentProvider, piAgentManager));
const piParticipant = vscode.chat.createChatParticipant('pi-agent', piContentProvider.createHandler());
this._register(vscode.chat.registerChatSessionContentProvider('pi-agent', piContentProvider, piParticipant));
```

### `package.json`

Two additions:
- Add `"@mariozechner/pi-coding-agent": "^<latest>"` to `dependencies`
- Add a `chatSessions` manifest entry (modelled on the `claude-code` entry at line 6008)

## Effort Estimate

~540 lines of net-new code. **4–6 hours** to a working MVP covering: streaming text, cancellation (subject to SDK API verification), basic tool event display, and a new `pi-agent` chat session type wired into the extension.

Out of scope for MVP: slash commands, session history UI, settings panel, MCP integration, hooks, model picker UI.

---

# Key Technical Decisions — Please Review

The decisions below shape the integration. Items marked **BLOCKING** require your input before implementation. Others have a sensible default I'll proceed with unless you say otherwise.

## DECISION 1: SDK vs. RPC process — **BLOCKING**

**Two options:**

**A) npm SDK** (`import { createAgentSession } from "@mariozechner/pi-coding-agent"`)
- Pro: No process management, same pattern as Claude integration, typed API
- Con: Bundles pi's entire dependency tree into the extension (size unknown until installed); pi SDK version locked to whatever we ship

**B) Spawn `pi --mode rpc`**
- Pro: Uses whatever version of `pi` the user has installed; zero bundle size increase; easy to update pi independently
- Con: Need `pi` CLI on PATH; more complex process lifecycle code; need to implement strict LF-delimited JSONL framing

**Recommendation: A (SDK)** — matches existing patterns, no PATH dependency. But if pi's npm package is very large (>5MB unpacked) the RPC approach becomes preferable.

> My call: SDK


## DECISION 2: API key / auth — **BLOCKING**

The pi SDK uses `AuthStorage.create()` which by default reads from pi's own config files (`~/.pi/`).

**A) Let pi handle auth itself** — `AuthStorage.create()` with no overrides. User runs `pi auth login` in their terminal once, done.

**B) VS Code secret storage** — Add a `github.copilot.pi.apiKey` setting (type `string`, `secret: true`), read it at session start, pass it to `AuthStorage`.

**Recommendation: A** — least friction, no new settings UI to build. If a user already uses pi CLI they're already authenticated.

> My call: Offer both paths?

## DECISION 3: Cancellation

The pi SDK docs don't document an abort API on `AgentSession`.

**A) Assume `session.abort()` exists** — common SDK pattern, verify once we have the package installed
**B) Use an `AbortController`** passed to `createAgentSession` (some SDKs accept this)
**C) Ignore cancellation for MVP** — when user clicks stop, just stop consuming events; let the agent finish its current tool call

I'll verify the actual API when I install the package. If no abort exists, I'll use option C for MVP and flag it as a known limitation.

## DECISION 4: Model selection — **BLOCKING**

The pi SDK supports 15+ providers and models.

**A) Use pi's configured default** — whatever the user set in their pi config; no UI needed
**B) Add a VS Code setting** `github.copilot.pi.model` (e.g. `"anthropic/claude-sonnet-4-5"`)
**C) Let the VS Code model picker drive it** — register pi models via `vscode.lm.registerChatModelProvider` (complex, like the Claude integration does)

**Recommendation: B** — simple string setting, user can change it without rebuilding, no need to enumerate all 15 providers.

> My call: C. We want the experience to be first class and as seamless as possible, and the model picker is the standard way users select models in the extension. We can dynamically populate the model picker with pi's available models at session start.

## DECISION 5: Session persistence across chat turns

**A) Persistent session** — create the pi session once, call `session.prompt()` for each turn. The agent retains memory of the whole conversation. This is how Claude integration works.

**B) Fresh session per turn** — call `createAgentSession` + `session.prompt()` + discard on every message. Simpler code, no session lifecycle to manage.

**Recommendation: A (persistent)** — this is the whole point of an agentic session; you want it to remember context and file edits across turns.

## DECISION 6: Tool event display

When pi runs `read`, `write`, `edit`, or `bash` tools, do we surface them in the chat UI?

**A) Silent** — only show final text output
**B) Progress messages** — `stream.progress("Running bash: npm test")` for each tool call
**C) Full tool blocks** — use `stream.toolCall()` / `stream.toolResult()` if the VS Code API exposes it (it does in some modes)

**Recommendation: B** — progress messages are low-effort to implement and give the user useful feedback without cluttering the conversation.

> My feedback: Agree

## DECISION 7: `when` condition for the session entry

The Claude session has `"when": "config.github.copilot.chat.claudeAgent.enabled"` so it's hidden by default behind a config flag.

**A) Always visible** — no `when` condition; pi session appears for all users
**B) Feature flag** — `"when": "config.github.copilot.chat.piAgent.enabled"` hidden by default

**Recommendation: B** — keeps it opt-in, consistent with how Claude was shipped. Users enable it via settings.

> My feedback: Agree

## Summary

| # | Decision | Recommendation | Status |
|---|----------|---------------|--------|
| 1 | SDK bundle vs. spawn CLI | Bundle SDK | **BLOCKING** |
| 2 | Auth: pi's own vs. VS Code secret | Pi's own auth | **BLOCKING** |
| 3 | Cancellation | Verify on install, fallback to C | Default ok |
| 4 | Model selection | VS Code setting string | **BLOCKING** |
| 5 | Session persistence | Persistent across turns | Default ok |
| 6 | Tool event display | Progress messages only | Default ok |
| 7 | Feature flag | Hidden by default | Default ok |

Once decisions 1, 2, and 4 are confirmed, implementation can begin. Decisions 3, 5, 6, and 7 will use the recommended defaults unless you say otherwise.