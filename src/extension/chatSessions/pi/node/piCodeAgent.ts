/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { Disposable, DisposableMap } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IPiModels } from './piModels';
import { IPiSdkService } from './piSdkService';

export interface IPiAgentManager {
	readonly _serviceBrand: undefined;
	handleRequest(
		piSessionId: string,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		cwd: string,
		isNewSession: boolean,
	): Promise<vscode.ChatResult>;
}

export const IPiAgentManager = createServiceIdentifier<IPiAgentManager>('IPiAgentManager');

/**
 * One per extension lifecycle. Owns the map of VS Code session ID → PiCodeSession.
 */
export class PiAgentManager extends Disposable implements IPiAgentManager {
	declare _serviceBrand: undefined;

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
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		cwd: string,
		isNewSession: boolean,
	): Promise<vscode.ChatResult> {
		try {
			let session: PiCodeSession;
			if (this._sessions.has(piSessionId)) {
				this.logService.trace(`[PiAgentManager] Reusing session ${piSessionId}`);
				session = this._sessions.get(piSessionId)!;
			} else {
				this.logService.trace(`[PiAgentManager] Creating new session ${piSessionId}`);
				session = this.instantiationService.createInstance(PiCodeSession, piSessionId, cwd);
				this._sessions.set(piSessionId, session);
			}

			await session.invoke(request, stream, token, isNewSession);
			return {};
		} catch (err) {
			this.logService.error(`[PiAgentManager] Request failed for session ${piSessionId}`, err);
			const message = err instanceof Error ? err.message : String(err);
			return { errorDetails: { message } };
		}
	}
}

/**
 * One per VS Code chat session. Owns the pi SDK AgentSession.
 */
class PiCodeSession extends Disposable {
	private _agentSession: AgentSession | undefined;

	constructor(
		private readonly _vsCodeSessionId: string,
		private readonly _cwd: string,
		@IPiSdkService private readonly _sdkService: IPiSdkService,
		@IPiModels private readonly _piModels: IPiModels,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	override dispose(): void {
		this._agentSession?.dispose();
		super.dispose();
	}

	public async invoke(
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		isNewSession: boolean,
	): Promise<void> {
		const modelId = request.model.id;
		let piModel: Model<any> | undefined;
		if (modelId) {
			piModel = await this._piModels.findModel(modelId);
			if (!piModel) {
				this._logService.warn(`[PiCodeSession] Model not found for VS Code model ID: ${modelId}`);
			}
		}

		const apiKeyOverride = this._getApiKeyOverride();

		if (!this._agentSession) {
			this._logService.trace(`[PiCodeSession] Initializing pi AgentSession for ${this._vsCodeSessionId}`);
			const authStorage = await this._piModels.getAuthStorage();
			if (apiKeyOverride) {
				// Inject VS Code-provided key as runtime override; provider is unknown,
				// so inject for the selected model's provider if available.
				const provider = piModel?.provider;
				if (provider) {
					authStorage.setRuntimeApiKey(provider, apiKeyOverride);
				}
			}

			const result = await this._sdkService.createAgentSession({
				cwd: this._cwd,
				...(piModel ? { model: piModel } : {}),
				authStorage,
			});
			this._agentSession = result.session;
		} else if (piModel && this._agentSession.model?.id !== piModel.id) {
			// Model switched between turns — update the session's model
			try {
				await this._agentSession.setModel(piModel);
			} catch (err) {
				this._logService.warn(`[PiCodeSession] Could not switch model: ${err}`);
			}
		}

		const agentSession = this._agentSession;
		const done = new DeferredPromise<void>();
		let unsubscribe: (() => void) | undefined;

		const handleEvent = (event: AgentSessionEvent) => {
			switch (event.type) {
				case 'message_update': {
					const e = event.assistantMessageEvent;
					if (e.type === 'text_delta') {
						stream.markdown(e.delta);
					}
					break;
				}
				case 'tool_execution_start': {
					stream.progress(event.toolName);
					break;
				}
				case 'agent_end': {
					unsubscribe?.();
					done.complete();
					break;
				}
				case 'auto_retry_start': {
					stream.progress(vscode.l10n.t('Retrying… (attempt {0}/{1})', event.attempt, event.maxAttempts));
					break;
				}
			}
		};

		unsubscribe = agentSession.subscribe(handleEvent);

		// Wire up cancellation
		const cancelReg = token.onCancellationRequested(async () => {
			this._logService.trace(`[PiCodeSession] Cancellation requested for session ${this._vsCodeSessionId}`);
			unsubscribe?.();
			try {
				await agentSession.abort();
			} catch {
				// ignore abort errors
			}
			done.complete();
		});

		try {
			await agentSession.prompt(request.prompt);
			await done.p;
		} finally {
			cancelReg.dispose();
			unsubscribe?.();
		}
	}

	private _getApiKeyOverride(): string | undefined {
		const config = vscode.workspace.getConfiguration('github.copilot.chat');
		const key = config.get<string>('piAgent.apiKey');
		return key && key.trim() ? key.trim() : undefined;
	}
}
