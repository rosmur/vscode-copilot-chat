/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
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
 * Why this exists: the `chatSessions` manifest entry sets
 * `requiresCustomModels: true`, which tells VS Code "do not let the user pick
 * a Copilot model for this session — use a model from this provider instead".
 *
 * What this populates: real pi models from `ModelRegistry.getAll()`. That
 * includes built-in models AND custom ones the user defined in
 * `~/.pi/agent/models.json`. Each entry is tagged with
 * `targetChatSessionType: 'pi-agent'` so it only appears in our session.
 *
 * What this does NOT do: actually drive the request. `provideLanguageModelChatResponse`
 * is intentionally empty — the real work happens in `PiChatSessionContentProvider`'s
 * chat participant handler, which streams pi SDK events into the chat response.
 *
 * Fallback: if pi cannot load any models (auth misconfigured, network down,
 * etc.) we still expose a single placeholder so the picker is not empty,
 * which would otherwise cause VS Code to fall back to Copilot models.
 */
export class PiModels extends Disposable implements IPiModels {
	declare _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());

	constructor(
		@IPiSdkService private readonly piSdkService: IPiSdkService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	public registerLanguageModelChatProvider(lm: typeof vscode['lm']): void {
		this.logService.info(`[PiModels] Registering LanguageModelChatProvider for vendor "${PiSessionUri.scheme}"`);

		const provider: vscode.LanguageModelChatProvider = {
			onDidChangeLanguageModelChatInformation: this._onDidChange.event,
			provideLanguageModelChatInformation: async () => {
				const infos = await this._enumerateModels();
				this.logService.info(`[PiModels] provideLanguageModelChatInformation returning ${infos.length} model(s): ${infos.map(i => `${i.id} (${i.name})`).join(', ')}`);
				return infos;
			},
			provideLanguageModelChatResponse: async (model, _messages, _options, _progress, _token) => {
				// Implemented via chat participants — see PiChatSessionContentProvider.
				// This path is only hit if VS Code routes a request through the LM API
				// directly rather than through our chat participant. Log so we notice.
				this.logService.warn(`[PiModels] provideLanguageModelChatResponse called for ${model.id} — unexpected; chat participant should be handling this`);
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

		// Fire change event once after a microtask so VS Code re-queries the model list.
		// Mirrors the pattern in claudeCodeModels.ts.
		queueMicrotask(() => this._onDidChange.fire());
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
		// Compose a stable id of `provider/model-id`. PiCodeSession parses this
		// in createSession and forwards to ModelRegistry.find(provider, id).
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
