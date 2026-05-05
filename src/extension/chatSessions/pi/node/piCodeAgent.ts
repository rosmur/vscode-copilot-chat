/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { Disposable, DisposableMap } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { formatHistoryAsContext } from './piHistoryReplay';
import { IPiSdkService } from './piSdkService';

/**
 * Owns the lifecycle of pi sessions and dispatches chat requests to them.
 * One instance per extension activation.
 */
export class PiAgentManager extends Disposable {
	private readonly _sessions = this._register(new DisposableMap<string, PiCodeSession>());

	constructor(
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	public async handleRequest(
		piSessionId: string,
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> {
		try {
			let session = this._sessions.get(piSessionId);
			if (!session) {
				this.logService.trace(`[PiAgentManager] Creating Pi session ${piSessionId}`);
				session = this.instantiationService.createInstance(PiCodeSession, piSessionId);
				this._sessions.set(piSessionId, session);
				// Stash any prior history. It is folded into the first prompt so the
				// agent has context across VS Code reloads. No-op for brand-new sessions.
				session.seedHistory(context.history);
			} else {
				this.logService.trace(`[PiAgentManager] Reusing Pi session ${piSessionId}`);
			}

			await session.invoke(request, stream, token);
			return {};
		} catch (err) {
			const isAbort = err instanceof Error && (
				err.name === 'AbortError' ||
				/abort|cancel/i.test(err.message ?? '')
			);
			if (isAbort) {
				this.logService.trace('[PiAgentManager] Request aborted/cancelled');
				return {};
			}
			this.logService.error(err as Error);
			const message = err instanceof Error ? err.message : String(err);
			stream.markdown(l10n.t('Pi error: {0}', message));
			return { errorDetails: { message } };
		}
	}
}

/**
 * Per-VS-Code-session wrapper around a pi `AgentSession`.
 *
 * Multi-turn behaviour: the SDK session is created lazily on the first prompt
 * and reused for every subsequent turn so the agent retains memory.
 *
 * Concurrency: requests are serialised via `_currentPrompt`. Pi exposes
 * `steer`/`followUp` for in-flight queueing, but MVP keeps things simple —
 * if a second request arrives while one is streaming, the user's cancellation
 * model already covers it (they can stop the current run).
 */
export class PiCodeSession extends Disposable {
	private _sdkSession: AgentSession | undefined;
	private _sdkSessionStarting: Promise<AgentSession> | undefined;
	private _currentPrompt: Promise<void> | undefined;
	private _pendingHistoryContext: string | undefined;

	constructor(
		public readonly sessionId: string,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@IPiSdkService private readonly piSdkService: IPiSdkService,
	) {
		super();
	}

	public override dispose(): void {
		// Best-effort: dispose the SDK session if we have one. dispose() is sync,
		// abort() is async — fire and forget the abort first.
		this._sdkSession?.abort().catch(() => { /* ignore */ });
		this._sdkSession?.dispose();
		this._sdkSession = undefined;
		super.dispose();
	}

	public seedHistory(history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>): void {
		this._pendingHistoryContext = formatHistoryAsContext(history);
	}

	public async invoke(
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<void> {
		// Serialise turns. If a prior prompt is still in flight, wait for it.
		// This is rare — the chat UI normally blocks input during streaming —
		// but defensive ordering matters for cancellation correctness.
		const previous = this._currentPrompt;
		const next = this._runPrompt(request, stream, token, previous);
		this._currentPrompt = next.finally(() => {
			if (this._currentPrompt === next) {
				this._currentPrompt = undefined;
			}
		});
		return next;
	}

	private async _runPrompt(
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		previous: Promise<void> | undefined,
	): Promise<void> {
		if (previous) {
			await previous.catch(() => { /* its own caller already saw the error */ });
		}
		if (token.isCancellationRequested) {
			return;
		}

		const sdk = await this._getOrCreateSdkSession();

		const cancelSub = token.onCancellationRequested(() => {
			this.logService.trace(`[PiCodeSession] Cancellation requested; calling session.abort()`);
			sdk.abort().catch(err => this.logService.warn(`[PiCodeSession] abort() rejected: ${err}`));
		});

		const unsubscribe = sdk.subscribe(event => this._dispatchEvent(event, stream));

		try {
			const promptText = this._pendingHistoryContext
				? `${this._pendingHistoryContext}\n\n[Current request:]\n${request.prompt}`
				: request.prompt;
			this._pendingHistoryContext = undefined;
			await sdk.prompt(promptText);
		} finally {
			unsubscribe();
			cancelSub.dispose();
		}
	}

	private _dispatchEvent(event: AgentSessionEvent, stream: vscode.ChatResponseStream): void {
		switch (event.type) {
			case 'message_update': {
				const inner = event.assistantMessageEvent;
				if (inner.type === 'text_delta') {
					stream.markdown(inner.delta);
				}
				return;
			}
			case 'tool_execution_start': {
				// Phase 1: progress messages only; Phase 3 may upgrade to full tool blocks.
				stream.progress(l10n.t('Running {0}…', event.toolName));
				return;
			}
			default:
				return;
		}
	}

	private async _getOrCreateSdkSession(): Promise<AgentSession> {
		if (this._sdkSession) {
			return this._sdkSession;
		}
		this._sdkSessionStarting ??= this._createSdkSession();
		try {
			this._sdkSession = await this._sdkSessionStarting;
			return this._sdkSession;
		} finally {
			this._sdkSessionStarting = undefined;
		}
	}

	private async _createSdkSession(): Promise<AgentSession> {
		const cwd = this._resolveCwd();
		this.logService.trace(`[PiCodeSession] Creating SDK session for ${this.sessionId} in ${cwd}`);
		return this.piSdkService.createSession({ cwd });
	}

	private _resolveCwd(): string {
		const folders = this.workspaceService.getWorkspaceFolders();
		if (folders.length > 0) {
			return folders[0].fsPath;
		}
		return this.envService.userHome.fsPath;
	}
}
