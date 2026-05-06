# Pi.dev Integration Plan

Integrate the [pi coding agent](https://pi.dev) (npm: [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent), v0.73.0, MIT, 11.2 MB unpacked) as a new chat session type. The VS Code chat panel becomes a frontend for the pi agent.

**Status**: Phase 0 ✅ DONE · Phase 1 ✅ SHIPPED (model picker absorbed) · Phase 2 partly absorbed into Phase 1 · Phase 3 pending demand.

---

## Phase 0 — Verify SDK shape ✅ DONE

Verified against `@mariozechner/pi-coding-agent@0.73.0` (tarball + `dist/index.d.ts` + `docs/sdk.md` + `examples/sdk/01-minimal.ts` + a real esbuild bundle in a scratch directory). Commit `2a8f04a`.

### API answers

| Question | Answer |
|---|---|
| Factory export | `createAgentSession({...})` returns `{ session, extensionsResult, modelFallbackMessage? }`. Confirmed in `dist/index.d.ts:15` and `examples/sdk/01-minimal.ts:8`. |
| Cancellation | **`session.abort(): Promise<void>`** is a documented public method. Real abort, no fallback needed. There is also `session.dispose(): void` for full cleanup. |
| Multi-turn | Same `session` instance, repeated `session.prompt(text)`. During streaming use `session.steer(text)` or `session.followUp(text)`. |
| Streaming events | `session.subscribe(listener)` returns an unsubscribe fn. Event types: `message_update` (with `assistantMessageEvent.type === 'text_delta' \| 'thinking_delta'` carrying `.delta`), `tool_execution_start \| _update \| _end`, `message_start \| _end`, `agent_start \| _end`, `turn_start \| _end`, plus `queue_update`, `compaction_*`, `auto_retry_*`. |
| Auth | `AuthStorage.create()` is canonical. Reads `~/.pi/agent/auth.json`, env vars, and accepts runtime overrides via `authStorage.setRuntimeApiKey(provider, key)`. |
| Model selection | `ModelRegistry.getAll()` returns built-in + custom models from `models.json` (preferred over `getAvailable()` for local-only setups). `session.setModel(model)` swaps at runtime. |
| Sessions | `SessionManager.inMemory()` (Phase 1), `SessionManager.create(cwd)` for new persistent, `SessionManager.continueRecent(cwd)`, `SessionManager.open('/path/to/session.jsonl')`. JSONL on disk, tree-structured (id/parentId branching). |

### Bundle health

- **Bundle size: +11.7 MB** to `dist/extension.js`. No errors. esbuild emits its standard "large bundle" warning, nothing else.
- **Cold load**: ~180 ms in scratch test. In the extension host, paid lazily on first session open via dynamic `import()`.
- **`photon-node`** (native image module) was not pulled into the static bundle — only loaded on demand for image content. Phase 1 disables image attachments anyway.

Top contributors: `@mariozechner/jiti` (2.2 MB), `highlight.js` (1.5 MB), `@mistralai/mistralai` (1.2 MB), `@google/genai` (705 KB), provider SDKs etc. The TUI dep is only 283 KB — much smaller than feared.

### Decisions resolved

| # | Decision | Resolution |
|---|---|---|
| 1 | SDK bundle vs. spawn `pi --mode rpc` | ✅ **SDK** (with eyes-open +12 MB bundle cost) |
| 2 | Auth | ✅ Pi's own `AuthStorage.create()` resolution chain — `auth.json` → env vars → models.json fallback. VS Code SecretStorage layer deferred (no users requested it yet). |
| 3 | Cancellation | ✅ Real `session.abort()` |
| 4 | Model selection | ✅ Picker integration delivered (see Phase 1 below — got rolled in) |
| 5 | Session persistence across turns | ✅ Stateless per-call (works because VS Code re-sends full history); stateful caching deferred |
| 6 | Tool event display | ✅ Progress messages (Phase 1); full tool blocks deferred |
| 7 | Feature flag | ✅ `github.copilot.chat.piAgent.enabled`, default `false` |

---

## Phase 1 — MVP ✅ SHIPPED

Goal achieved: a working `pi-agent` chat session that streams text, supports cancellation, persists conversation across turns within a window, exposes pi's full model list (built-ins + custom from `~/.pi/agent/models.json`) in the VS Code model picker, behind the `github.copilot.chat.piAgent.enabled` feature flag (default off).

### What shipped

| File | LOC | Purpose | Commit |
|---|---|---|---|
| `src/extension/chatSessions/pi/common/piSessionUri.ts` | 22 | URI scheme `pi-agent` + helpers | `798d309` |
| `src/extension/chatSessions/pi/node/piSdkService.ts` | ~110 | DI wrapper around `@mariozechner/pi-coding-agent`, lazy dynamic import. Exposes `createSession({ cwd, model, apiKey })` and `listModels()`. | `798d309`, `188eceb` |
| `src/extension/chatSessions/pi/node/piModels.ts` | ~245 | `LanguageModelChatProvider` for `pi-agent` vendor. Enumerates pi models with `targetChatSessionType`, **drives responses end-to-end via the LM API path**. Forwards `text_delta` and `thinking_delta`, surfaces `state.errorMessage` on silent failures. | `8932426`, `1b51168`, `fb89040`, `5350b0f` |
| `src/extension/chatSessions/pi/node/piCodeAgent.ts` | ~210 | `PiAgentManager` + `PiCodeSession` — chat-participant fallback path. Kept defensively; the LM path is primary. | `798d309`, `188eceb` |
| `src/extension/chatSessions/pi/node/piHistoryReplay.ts` | ~70 | Formats prior chat history as a textual preamble for the chat-participant fallback path. | `798d309` |
| `src/extension/chatSessions/vscode-node/piChatSessionContentProvider.ts` | ~60 | `vscode.ChatSessionContentProvider` with diagnostic logging. | `798d309`, `1b51168` |

### Modifications

- **`src/extension/chatSessions/vscode-node/chatSessions.ts`** — Pi block after the Claude block, registers PiSdkService, PiAgentManager, PiModels (LM provider), PiChatSessionContentProvider, and the chat participant. Logs `[ChatSessionsContrib] Pi chat session registered` at startup. (`798d309`, `1b51168`)
- **`package.json`**:
  - `chatSessions` entry with `type: pi-agent`, `requiresCustomModels: true`, `capabilities.supportsImageAttachments: false`, icon `$(robot)` (default codicon — custom icon deferred). (`798d309`, `8932426`)
  - `languageModelChatProviders` entry for vendor `pi-agent` with `when: false` (mirrors Claude's pattern). (`8932426`)
  - `dependencies['@mariozechner/pi-coding-agent']` pinned to `0.73.0` (exact, not caret — pi pre-1.0 churn). (`798d309`)
  - Config schema for `github.copilot.chat.piAgent.enabled` (boolean, default false) and `github.copilot.chat.piAgent.model` (string, default empty — `provider/model-id` selector that overrides pi's settings.json default). (`798d309`, `188eceb`)
- **`package.nls.json`** — l10n strings for the config keys and provider description. (`798d309`, `188eceb`)
- **`src/platform/configuration/common/configurationService.ts`** — `ConfigKey.PiAgentEnabled`, `ConfigKey.PiAgentModel`. (`798d309`, `188eceb`)
- **`.esbuild.ts`** — extended `importMetaPlugin` with a sibling filter for `@mariozechner/pi-*` packages. The shim uses `'file:///' + module.filename.replace(/\\/g, '/').replace(/^\//, '')` (require-free, no `__filename` reference) to avoid esbuild renaming our shim to collide with pi/jiti's own `const __filename` / `const require` declarations. (`798d309`, `3a8bf52`, `06e5312`)

### Bugs found and fixed during Phase 1

1. **Manifest-routing**: chatSessions entry was missing `requiresCustomModels: true`, so VS Code routed pi-session prompts through the default Copilot participant instead of ours. Set `requiresCustomModels: true` and added a `languageModelChatProviders` declaration. (`8932426`)
2. **`__filename` collision in the esbuild shim**: pi's `const __filename = fileURLToPath(import.meta.url)` got renamed to `__filename2` by esbuild, and our shim's `__filename` reference was renamed too — producing `__filename2 = fileURLToPath(pathToFileURL(__filename2).href)`, a self-initialiser. (`3a8bf52`)
3. **`require` collision**: jiti's `const require = createRequire(import.meta.url)` had the same problem with our `require("url")` shim, which got renamed to `require2("url")` and was called inside `require2`'s own initialiser. Fix was to drop `require()` entirely and build the file URL by string concatenation. (`06e5312`)
4. **Routing bypass**: the chat-participant pattern Claude uses doesn't apply to us — VS Code drives pi-session requests through the LM API (`provideLanguageModelChatResponse`) when `requiresCustomModels: true`. We rebuilt the LM-provider response method to fully drive pi instead of being a no-op. (`fb89040`)
5. **`cwd=/` in empty workspaces**: empty-workspace fallback used `process.cwd()` which is `/` in the extension host. Switched to `envService.userHome.fsPath`. (`5350b0f`)
6. **Reasoning models silent**: only `text_delta` was forwarded, so qwen3/o1/etc. emitting `thinking_delta` produced empty responses. Now forwarded as `vscode.LanguageModelThinkingPart`. (`5350b0f`)
7. **Silent pi failures**: pi's internal errors set `agent.state.errorMessage` without throwing from `prompt()`. Now read after `prompt()` resolves and surfaced as `**Pi error:** …` in the chat. (`5350b0f`)

### Bonus over the original Phase 1 scope

The model picker was originally Phase 2 (~1,000 LOC, 2–3 days). It got pulled into Phase 1 because:
- `requiresCustomModels: true` is required for correct routing (item 1 above), which forces a `LanguageModelChatProvider` registration.
- Pi exposes its full model list cheaply via `ModelRegistry.getAll()` — no proxy server needed (Claude's `claudeLanguageModelServer.ts:751` exists because it bridges to GitHub Copilot's API; pi calls model APIs directly).
- The LM provider also became the response driver (item 4 above), making the Claude-style chat-participant + proxy server pattern unnecessary.

Net result: real Phase 1 ended up at **~720 LOC** with the model picker included, instead of the ~600 LOC originally projected for Phase 1 alone.

### Out of scope for Phase 1 (still deferred)

- Session listing / disk persistence across VS Code restarts
- Stateful pi session caching (per-LM-call session is correct but inefficient)
- Slash commands (`/init`, `/review`, etc.)
- Tool permission UI
- MCP servers, hooks, customization provider
- Multi-root workspace folder picker
- Image attachments
- Custom icon contribution

---

## Phase 2 — Mostly absorbed into Phase 1 ✅

Original Phase 2 (model picker via `lm.registerChatModelProvider`) shipped with Phase 1.

What's left of "Phase 2" is now optimisation rather than feature delivery:

- **Stateful session caching**. Each LM call currently creates a fresh `AgentSession` and replays the message history. A cache keyed on chat session id would let pi keep a single session per conversation, improving latency and avoiding redundant prompt processing. Requires tighter coupling with pi-ai's `AgentMessage` shape if we want to preserve tool-call history; otherwise can stick with text replay.
- **Per-model `LanguageModelConfigurationSchema`**. The LM API supports per-model config (e.g. thinking level, custom temperature) declared in the manifest. Useful for exposing pi's `thinkingLevel` and per-provider headers as picker options.

---

## Phase 3 — Optional enrichments (demand-driven)

- Disk session persistence + session list provider (item provider, not just content provider)
- Tool event display upgrade — full tool blocks via the LM API's tool-call parts
- Slash commands (`/init`, `/review`, etc.)
- Customization provider (`vscode.chat.registerChatSessionCustomizationProvider`) for per-session settings UI
- Multi-root folder picker
- Image attachments (requires validating `photon-node` loads under the extension host)
- Custom icon contribution
- VS Code SecretStorage layer for API keys (currently pi's own `~/.pi/agent/auth.json` handles this fine)

---

## Effort actuals vs. estimate

| Phase | Estimated | Actual | Notes |
|---|---|---|---|
| 0 — Verify SDK | 1–2 hrs | ~1 hr | One PR |
| 1 — MVP (with model picker absorbed) | 1–2 days for MVP + 2–3 days for picker | ~1 day across multiple iterations | Bug-fix iterations dominated effort vs. greenfield code |
| 2 — Model picker | (absorbed) | n/a | |
| 3 — Enrichments | varies | not started | Demand-driven |

The original 540 LOC / 4–6 hrs estimate from before this plan was rewritten was off by ~3x in code volume and effort. The rewritten plan's ~1,600 LOC across Phases 1+2 was within ~50% of actual.

---

## Risks — retrospective

1. ~~**Bundle bloat / native deps**~~ — `photon-node` was not statically bundled. Bundle is +11.7 MB, acceptable.
2. ~~**TUI dependency leakage**~~ — only 283 KB ended up in the bundle.
3. **Pi SDK is young** — confirmed real concern. Pinned to exact `0.73.0`. Watch for breaking changes when bumping.
4. **Routing semantics undocumented** — `requiresCustomModels`, `targetChatSessionType`, and the LM-API-vs-chat-participant routing for custom session types are not in the proposed-API d.ts files we have access to. Discovered behaviour empirically. Future VS Code releases may shift this.
5. **Bundling artifacts** — esbuild renamed shim variables to collide with pi/jiti's own declarations. Encountered twice (`__filename`, `require`). The fix pattern (use member expressions and string literals, never bare identifiers) is documented inline in `.esbuild.ts`.
