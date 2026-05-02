/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AuthStorage, CreateAgentSessionOptions, CreateAgentSessionResult, ModelRegistry } from '@mariozechner/pi-coding-agent';
import { createServiceIdentifier } from '../../../../util/common/services';

export interface IPiSdkService {
	readonly _serviceBrand: undefined;

	/**
	 * Creates a new pi agent session. Lazy-loads the SDK on first call.
	 */
	createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;

	/**
	 * Creates a ModelRegistry backed by the given AuthStorage.
	 */
	createModelRegistry(authStorage: AuthStorage): Promise<ModelRegistry>;

	/**
	 * Creates an AuthStorage backed by pi's default config directory (~/.pi/).
	 */
	createAuthStorage(agentDir?: string): Promise<AuthStorage>;
}

export const IPiSdkService = createServiceIdentifier<IPiSdkService>('IPiSdkService');

/**
 * Thin DI wrapper around the @mariozechner/pi-coding-agent SDK.
 * Lazy-loads the package on first use so extension startup cost is zero.
 */
export class PiSdkService implements IPiSdkService {
	readonly _serviceBrand: undefined;

	private _sdk: Promise<typeof import('@mariozechner/pi-coding-agent')> | undefined;

	private _loadSdk() {
		this._sdk ??= import('@mariozechner/pi-coding-agent');
		return this._sdk;
	}

	public async createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
		const { createAgentSession } = await this._loadSdk();
		return createAgentSession(options);
	}

	public async createModelRegistry(authStorage: AuthStorage): Promise<ModelRegistry> {
		const { ModelRegistry } = await this._loadSdk();
		return ModelRegistry.inMemory(authStorage);
	}

	public async createAuthStorage(agentDir?: string): Promise<AuthStorage> {
		const { AuthStorage } = await this._loadSdk();
		return AuthStorage.create(agentDir);
	}
}
