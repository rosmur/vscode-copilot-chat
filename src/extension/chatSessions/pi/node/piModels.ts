/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import { ILogService } from '../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IPiSdkService } from './piSdkService';

/** VS Code model ID prefix for pi models: `{provider}/{model.id}` */
export function piModelId(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/** Parse a VS Code pi model ID back to provider + model ID */
export function parsePiModelId(vsCodeModelId: string): { provider: string; modelId: string } | undefined {
	const slashIdx = vsCodeModelId.indexOf('/');
	if (slashIdx === -1) {
		return undefined;
	}
	return {
		provider: vsCodeModelId.slice(0, slashIdx),
		modelId: vsCodeModelId.slice(slashIdx + 1),
	};
}

export interface IPiModels {
	readonly _serviceBrand: undefined;
	/**
	 * Registers pi's available models with the VS Code model picker so they appear
	 * in the built-in model dropdown for the pi-agent session type.
	 */
	registerLanguageModelChatProvider(lm: typeof vscode['lm']): void;

	/**
	 * Resolves a VS Code model ID (as returned by request.model.id) to the
	 * corresponding pi Model object. Returns undefined if not found.
	 */
	findModel(vsCodeModelId: string): Promise<Model<any> | undefined>;

	/**
	 * Returns the ModelRegistry, creating it on first call.
	 * Accepts an optional VS Code API key to inject as a runtime override.
	 */
	getRegistry(apiKeyOverride?: string): Promise<ModelRegistry>;

	/**
	 * Returns the AuthStorage, creating it on first call.
	 */
	getAuthStorage(): AuthStorage;
}

export const IPiModels = createServiceIdentifier<IPiModels>('IPiModels');

export class PiModels extends Disposable implements IPiModels {
	declare _serviceBrand: undefined;

	private _authStorage: AuthStorage | undefined;
	private _registry: ModelRegistry | undefined;
	private readonly _onDidChange = this._register(new Emitter<void>());

	constructor(
		@IPiSdkService private readonly sdkService: IPiSdkService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	public getAuthStorage(): AuthStorage {
		this._authStorage ??= this.sdkService.createAuthStorage();
		return this._authStorage;
	}

	public async getRegistry(apiKeyOverride?: string): Promise<ModelRegistry> {
		if (!this._registry) {
			const auth = this.getAuthStorage();
			this._registry = this.sdkService.createModelRegistry(auth);
		}
		if (apiKeyOverride) {
			// Inject the VS Code-provided key as a runtime override for all providers
			// that lack configured auth. We don't know the provider, so inject it for
			// known providers; the registry will use the first that matches the model.
			const knownProviders = ['anthropic', 'openai', 'google', 'deepseek', 'xai'];
			for (const p of knownProviders) {
				if (!this._registry.getProviderAuthStatus(p).configured) {
					this._registry.authStorage.setRuntimeApiKey(p, apiKeyOverride);
				}
			}
		}
		return this._registry;
	}

	public async findModel(vsCodeModelId: string): Promise<Model<any> | undefined> {
		const parsed = parsePiModelId(vsCodeModelId);
		if (!parsed) {
			return undefined;
		}
		const registry = await this.getRegistry();
		return registry.find(parsed.provider, parsed.modelId);
	}

	public registerLanguageModelChatProvider(lm: typeof vscode['lm']): void {
		const provider: vscode.LanguageModelChatProvider = {
			onDidChangeLanguageModelChatInformation: this._onDidChange.event,
			provideLanguageModelChatInformation: async (_options, _token) => {
				return this._provideLanguageModelChatInfo();
			},
			provideLanguageModelChatResponse: async (_model, _messages, _options, _progress, _token) => {
				// Implemented via chat participants.
			},
			provideTokenCount: async (_model, _text, _token) => {
				return 0;
			},
		};
		this._register(lm.registerLanguageModelChatProvider('pi-agent', provider));

		// Eagerly trigger a registry refresh so models populate quickly
		void this._provideLanguageModelChatInfo().then(() => this._onDidChange.fire());
	}

	private async _provideLanguageModelChatInfo(): Promise<vscode.LanguageModelChatInformation[]> {
		try {
			const registry = await this.getRegistry();
			const models = registry.getAvailable();
			return models.map(m => ({
				id: piModelId(m.provider, m.id),
				name: m.name,
				family: m.provider,
				version: m.id,
				maxInputTokens: m.contextWindow,
				maxOutputTokens: m.maxTokens,
				isUserSelectable: true,
				capabilities: {
					imageInput: m.input.includes('image'),
					toolCalling: false, // pi manages its own tool dispatch
				},
				targetChatSessionType: 'pi-agent',
			}));
		} catch (err) {
			this.logService.error('[PiModels] Failed to load available models', err);
			return [];
		}
	}
}
