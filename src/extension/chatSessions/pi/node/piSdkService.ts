/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSession, CreateAgentSessionOptions } from '@mariozechner/pi-coding-agent';
import { createServiceIdentifier } from '../../../../util/common/services';

/**
 * Subset of pi-ai's `Model` we need for populating the VS Code model picker.
 * Re-declared here so callers don't import the full pi-ai types.
 */
export interface PiModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ReadonlyArray<'text' | 'image'>;
}

export interface IPiSdkService {
	readonly _serviceBrand: undefined;

	/**
	 * Creates a new pi agent session.
	 *
	 * - `apiKey`: optional runtime override on the AuthStorage (not persisted).
	 *   When omitted, pi falls back to its own resolution order:
	 *   `~/.pi/agent/auth.json` → environment variables → models.json fallback.
	 * - `model`: optional `{ provider, id }` selector. When omitted, pi uses the
	 *   default from `~/.pi/agent/settings.json`. Custom models from
	 *   `~/.pi/agent/models.json` are resolved by the registry.
	 *   Throws if the requested model is not found.
	 */
	createSession(options: {
		cwd: string;
		apiKey?: { provider: string; key: string };
		model?: { provider: string; id: string };
		additionalOptions?: CreateAgentSessionOptions;
	}): Promise<AgentSession>;

	/**
	 * Returns the full set of pi models — built-in plus the user's custom ones
	 * from `~/.pi/agent/models.json`. Used by the VS Code model picker.
	 */
	listModels(): Promise<PiModelInfo[]>;
}

export const IPiSdkService = createServiceIdentifier<IPiSdkService>('IPiSdkService');

/**
 * Wraps the pi-coding-agent SDK behind a DI service.
 *
 * The SDK is loaded with a dynamic `import()` so the ~12 MB module graph is
 * paid on first session creation, not at extension activation.
 */
export class PiSdkService implements IPiSdkService {
	readonly _serviceBrand: undefined;

	private _sdk: Promise<typeof import('@mariozechner/pi-coding-agent')> | undefined;

	private _loadSdk() {
		this._sdk ??= import('@mariozechner/pi-coding-agent');
		return this._sdk;
	}

	public async createSession(options: {
		cwd: string;
		apiKey?: { provider: string; key: string };
		model?: { provider: string; id: string };
		additionalOptions?: CreateAgentSessionOptions;
	}): Promise<AgentSession> {
		const { createAgentSession, AuthStorage, ModelRegistry, SessionManager } = await this._loadSdk();

		const authStorage = AuthStorage.create();
		if (options.apiKey) {
			authStorage.setRuntimeApiKey(options.apiKey.provider, options.apiKey.key);
		}
		const modelRegistry = ModelRegistry.create(authStorage);

		let model: CreateAgentSessionOptions['model'];
		if (options.model) {
			model = modelRegistry.find(options.model.provider, options.model.id);
			if (!model) {
				throw new Error(`Pi model "${options.model.provider}/${options.model.id}" not found. Check ~/.pi/agent/models.json or the github.copilot.chat.piAgent.model setting.`);
			}
		}

		const { session } = await createAgentSession({
			cwd: options.cwd,
			sessionManager: SessionManager.inMemory(),
			authStorage,
			modelRegistry,
			model,
			...options.additionalOptions,
		});
		return session;
	}

	public async listModels(): Promise<PiModelInfo[]> {
		const { AuthStorage, ModelRegistry } = await this._loadSdk();
		const authStorage = AuthStorage.create();
		const modelRegistry = ModelRegistry.create(authStorage);
		// `getAll()` is more permissive than `getAvailable()` — the latter filters
		// to models with configured auth, which would exclude local-only setups
		// (e.g. Ollama in models.json with no api key needed).
		return modelRegistry.getAll().map(m => ({
			provider: m.provider,
			id: m.id,
			name: m.name,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			input: m.input,
		}));
	}
}
