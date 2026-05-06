/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import * as vscode from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { PiSessionUri } from '../common/piSessionUri';
import { IPiSdkService } from './piSdkService';

export interface IPiModels {
	readonly _serviceBrand: undefined;
	registerLanguageModelChatProvider(lm: typeof vscode['lm']): void;
}

export const IPiModels = createServiceIdentifier<IPiModels>('IPiModels');

/**
 * `LanguageModelChatProvider` for the pi-agent session type.
 *
 * Why this exists: with `requiresCustomModels: true` on the `chatSessions`
 * manifest entry, VS Code drives chat-session requests through the language
 * model API rather than through the chat participant for our session type.
 * That means **the actual response handling has to live here**, not (only)
 * in PiChatSessionContentProvider's chat participant handler.
 *
 * Each call to `provideLanguageModelChatResponse` creates a fresh pi
 * `AgentSession`, replays the prior conversation turns as the system context,
 * sends the latest user message via `session.prompt()`, and forwards
 * `text_delta` events back to VS Code as `LanguageModelTextPart`s.
 *
 * Multi-turn memory currently relies on VS Code re-sending the full message
 * array on each call (which it does). A future Phase 2 optimisation could
 * cache pi sessions keyed by chat session id to skip reprocessing prior
 * turns, but it requires deeper coupling with pi-ai's internal message shape.
 */
export class PiModels extends Disposable implements IPiModels {
	declare _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());

	constructor(
		@IPiSdkService private readonly piSdkService: IPiSdkService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INativeEnvService private readonly envService: INativeEnvService,
	) {
		super();
	}

	public registerLanguageModelChatProvider(lm: typeof vscode['lm']): void {
		this.logService.info(`[PiModels] Registering LanguageModelChatProvider for vendor "${PiSessionUri.scheme}"`);

		const provider: vscode.LanguageModelChatProvider = {
			onDidChangeLanguageModelChatInformation: this._onDidChange.event,
			provideLanguageModelChatInformation: async () => {
				const infos = await this._enumerateModels();
				this.logService.info(`[PiModels] provideLanguageModelChatInformation returning ${infos.length} model(s)`);
				return infos;
			},
			provideLanguageModelChatResponse: async (model, messages, _options, progress, token) => {
				this.logService.info(`[PiModels] provideLanguageModelChatResponse for ${model.id} with ${messages.length} message(s)`);
				await this._handleResponse(model, messages, progress, token);
			},
			provideTokenCount: async (_model, text) => {
				if (typeof text === 'string') {
					return Math.ceil(text.length / 4);
				}
				let chars = 0;
				for (const part of text.content) {
					if (typeof part === 'string') {
						chars += part.length;
					} else if (part && typeof (part as { value?: unknown }).value === 'string') {
						chars += (part as { value: string }).value.length;
					}
				}
				return Math.ceil(chars / 4);
			},
		};

		this._register(lm.registerLanguageModelChatProvider(PiSessionUri.scheme, provider));

		queueMicrotask(() => this._onDidChange.fire());
	}

	private async _handleResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		// Parse `provider/id` (split on first slash) — matches what we emit in
		// `_toLmInfo`. Fall back to no model selector if unparseable, letting
		// pi pick its default.
		const slash = model.id.indexOf('/');
		const modelSelector = slash > 0 && slash < model.id.length - 1
			? { provider: model.id.slice(0, slash), id: model.id.slice(slash + 1) }
			: undefined;

		const cwd = this._resolveCwd();
		this.logService.info(`[PiModels] Creating pi session cwd=${cwd} model=${modelSelector ? `${modelSelector.provider}/${modelSelector.id}` : '<default>'}`);

		let session: AgentSession;
		try {
			session = await this.piSdkService.createSession({ cwd, model: modelSelector });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.error(`[PiModels] createSession failed: ${msg}`);
			progress.report(new vscode.LanguageModelTextPart(`**Pi error:** ${msg}`));
			return;
		}

		const cancelSub = token.onCancellationRequested(() => {
			this.logService.info('[PiModels] Cancellation requested; aborting pi session');
			session.abort().catch(e => this.logService.warn(`[PiModels] abort() rejected: ${e}`));
		});

		let textChars = 0;
		let thinkingChars = 0;
		const eventCounts = new Map<string, number>();

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);

			if (event.type === 'message_update') {
				const inner = event.assistantMessageEvent;
				if (inner.type === 'text_delta' && inner.delta) {
					textChars += inner.delta.length;
					progress.report(new vscode.LanguageModelTextPart(inner.delta));
				} else if (inner.type === 'thinking_delta' && (inner as { delta?: string }).delta) {
					// Reasoning models (qwen3, o1, claude with thinking, etc.) emit
					// `thinking_delta` for their internal reasoning. Forward as a
					// proper thinking part so VS Code can render it collapsed.
					const delta = (inner as { delta: string }).delta;
					thinkingChars += delta.length;
					progress.report(new vscode.LanguageModelThinkingPart(delta));
				}
			} else if (event.type === 'tool_execution_start') {
				this.logService.info(`[PiModels] Tool start: ${event.toolName}`);
			} else if (event.type === 'tool_execution_end') {
				this.logService.info(`[PiModels] Tool end: ${event.toolName} ${(event as { isError?: boolean }).isError ? '(error)' : ''}`);
			}
		});

		try {
			const promptText = this._composePrompt(messages);
			this.logService.info(`[PiModels] Calling session.prompt() with ${promptText.length} chars`);
			await session.prompt(promptText);
			const summary = Array.from(eventCounts.entries()).map(([t, n]) => `${t}=${n}`).join(' ');
			this.logService.info(`[PiModels] session.prompt() resolved. text=${textChars}ch thinking=${thinkingChars}ch events: ${summary || '<none>'}`);

			// If the model produced no visible output, surface anything pi recorded
			// on the agent state so the user sees a real error instead of a silent
			// empty response.
			if (textChars === 0 && thinkingChars === 0) {
				const state = (session as { agent?: { state?: { errorMessage?: string; messages?: unknown[] } } }).agent?.state;
				const errorMessage = state?.errorMessage;
				const messageCount = state?.messages?.length ?? 0;
				this.logService.warn(`[PiModels] No content emitted. state.errorMessage="${errorMessage ?? '<none>'}" state.messages.length=${messageCount}`);
				if (errorMessage) {
					progress.report(new vscode.LanguageModelTextPart(`**Pi error:** ${errorMessage}`));
				} else {
					progress.report(new vscode.LanguageModelTextPart(
						`*(Pi produced no response. The model "${model.id}" may not be reachable or may not be configured correctly. ` +
						`Check the "Pi" output channel for details.)*`
					));
				}
			}
		} catch (err) {
			const isAbort = err instanceof Error && (
				err.name === 'AbortError' ||
				/abort|cancel/i.test(err.message ?? '')
			);
			if (!isAbort) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logService.error(`[PiModels] session.prompt() failed: ${msg}`);
				progress.report(new vscode.LanguageModelTextPart(`\n\n**Pi error:** ${msg}`));
			}
		} finally {
			unsubscribe();
			cancelSub.dispose();
			session.dispose();
		}
	}

	private _composePrompt(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
		// VS Code re-sends the full conversation each call. Pi's session is
		// stateless across LM API calls (we create a fresh one each time), so
		// we serialise prior turns as a textual transcript and append the
		// latest user prompt at the end. This is lossy for tool-call history
		// but preserves message-level context.
		if (messages.length === 0) {
			return '';
		}
		const last = messages[messages.length - 1];
		const lastText = this._extractText(last);

		if (messages.length === 1) {
			return lastText;
		}

		const lines: string[] = ['[Conversation so far:]'];
		for (let i = 0; i < messages.length - 1; i++) {
			const m = messages[i];
			const text = this._extractText(m);
			if (!text) {
				continue;
			}
			const role = m.role === vscode.LanguageModelChatMessageRole.User ? 'User' : 'Assistant';
			lines.push(`${role}: ${text}`);
		}
		lines.push('', '[Current request:]', lastText);
		return lines.join('\n\n');
	}

	private _extractText(message: vscode.LanguageModelChatRequestMessage): string {
		const parts: string[] = [];
		for (const part of message.content) {
			if (typeof part === 'string') {
				parts.push(part);
			} else if (part instanceof vscode.LanguageModelTextPart) {
				parts.push(part.value);
			} else if (part && typeof (part as { value?: unknown }).value === 'string') {
				parts.push((part as { value: string }).value);
			}
		}
		return parts.join('');
	}

	private _resolveCwd(): string {
		const folders = this.workspaceService.getWorkspaceFolders();
		if (folders.length > 0) {
			return folders[0].fsPath;
		}
		// Never fall back to process.cwd() — in the VS Code extension host that
		// is typically `/`, which breaks pi's tools (file paths resolved against
		// it land outside any project). Use the user's home directory instead.
		return this.envService.userHome.fsPath;
	}

	private async _enumerateModels(): Promise<vscode.LanguageModelChatInformation[]> {
		try {
			const models = await this.piSdkService.listModels();
			this.logService.info(`[PiModels] Pi reports ${models.length} model(s) from getAll()`);
			if (models.length === 0) {
				return [this._fallbackModel()];
			}
			return models.map(m => this._toLmInfo(m));
		} catch (err) {
			this.logService.error(`[PiModels] Failed to load pi models: ${err instanceof Error ? err.message : String(err)}`);
			return [this._fallbackModel()];
		}
	}

	private _toLmInfo(m: { provider: string; id: string; name: string; contextWindow: number; maxTokens: number; input: ReadonlyArray<'text' | 'image'> }): vscode.LanguageModelChatInformation {
		const id = `${m.provider}/${m.id}`;
		const info: vscode.LanguageModelChatInformation & {
			targetChatSessionType?: string;
			isUserSelectable?: boolean;
			isDefault?: boolean;
		} = {
			id,
			name: m.name,
			family: m.provider,
			version: '1',
			maxInputTokens: m.contextWindow,
			maxOutputTokens: m.maxTokens,
			capabilities: {
				toolCalling: true,
				imageInput: m.input.includes('image'),
			},
			targetChatSessionType: PiSessionUri.scheme,
			isUserSelectable: true,
		};
		return info;
	}

	private _fallbackModel(): vscode.LanguageModelChatInformation {
		this.logService.warn('[PiModels] No pi models available — registering placeholder so the picker is non-empty');
		const info: vscode.LanguageModelChatInformation & {
			targetChatSessionType?: string;
			isUserSelectable?: boolean;
			isDefault?: boolean;
		} = {
			id: 'pi-default',
			name: 'Pi (Auto)',
			family: 'pi',
			version: '1',
			maxInputTokens: 200_000,
			maxOutputTokens: 8_192,
			capabilities: { toolCalling: true },
			targetChatSessionType: PiSessionUri.scheme,
			isUserSelectable: true,
			isDefault: true,
		};
		return info;
	}
}
