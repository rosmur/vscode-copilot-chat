/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSession, CreateAgentSessionOptions } from '@mariozechner/pi-coding-agent';
import { createServiceIdentifier } from '../../../../util/common/services';

export interface IPiSdkService {
	readonly _serviceBrand: undefined;

	/**
	 * Creates a new pi agent session.
	 *
	 * If `apiKey` is provided it is set as a runtime override on the AuthStorage
	 * (not persisted to disk). Otherwise pi falls back to its own resolution
	 * order: `~/.pi/agent/auth.json` → environment variables.
	 */
	createSession(options: {
		cwd: string;
		apiKey?: { provider: string; key: string };
		additionalOptions?: CreateAgentSessionOptions;
	}): Promise<AgentSession>;
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
		additionalOptions?: CreateAgentSessionOptions;
	}): Promise<AgentSession> {
		const { createAgentSession, AuthStorage, ModelRegistry, SessionManager } = await this._loadSdk();

		const authStorage = AuthStorage.create();
		if (options.apiKey) {
			authStorage.setRuntimeApiKey(options.apiKey.provider, options.apiKey.key);
		}
		const modelRegistry = ModelRegistry.create(authStorage);

		const { session } = await createAgentSession({
			cwd: options.cwd,
			sessionManager: SessionManager.inMemory(),
			authStorage,
			modelRegistry,
			...options.additionalOptions,
		});
		return session;
	}
}
