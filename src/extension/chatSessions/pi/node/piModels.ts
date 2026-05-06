/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { PiSessionUri } from '../common/piSessionUri';

export interface IPiModels {
	readonly _serviceBrand: undefined;
	registerLanguageModelChatProvider(lm: typeof vscode['lm']): void;
}

export const IPiModels = createServiceIdentifier<IPiModels>('IPiModels');

/**
 * Stub `LanguageModelChatProvider` for the pi-agent session type.
 *
 * Why this exists: the `chatSessions` manifest entry sets
 * `requiresCustomModels: true`, which tells VS Code "do not let the user pick
 * a Copilot model for this session — use a model from this provider instead".
 * Without that flag, requests typed in the Pi session were being routed to
 * GitHub Copilot's default participant.
 *
 * What this does NOT do: actually drive the request. `provideLanguageModelChatResponse`
 * is intentionally empty — the real work happens in `PiChatSessionContentProvider`'s
 * chat participant handler, which streams pi SDK events into the chat response.
 *
 * The single virtual model exposed here is a placeholder labelled "Pi (Auto)".
 * It signals "let pi pick the model", which in practice means whatever the
 * user has in `~/.pi/agent/settings.json` or in `github.copilot.chat.piAgent.model`.
 * Phase 2 will replace this with one entry per available pi model from
 * `ModelRegistry.getAvailable()`.
 */
export class PiModels extends Disposable implements IPiModels {
	declare _serviceBrand: undefined;

	public registerLanguageModelChatProvider(lm: typeof vscode['lm']): void {
		const provider: vscode.LanguageModelChatProvider = {
			provideLanguageModelChatInformation: async () => {
				const info: vscode.LanguageModelChatInformation = {
					id: 'pi-default',
					name: 'Pi (Auto)',
					family: 'pi',
					version: '1',
					maxInputTokens: 200_000,
					maxOutputTokens: 8_192,
					capabilities: {
						toolCalling: true,
					},
				};
				// `targetChatSessionType` and `isUserSelectable` are on the proposed
				// chatProvider extension to LanguageModelChatInformation. Cast through
				// to attach them without dropping the base contract above.
				return [{
					...info,
					isUserSelectable: true,
					isDefault: true,
					targetChatSessionType: PiSessionUri.scheme,
				} as vscode.LanguageModelChatInformation];
			},
			provideLanguageModelChatResponse: async () => {
				// Implemented via chat participants — see PiChatSessionContentProvider.
			},
			provideTokenCount: async (_model, text) => {
				// Rough approximation. Real token counting is unnecessary here — the
				// chat participant handler drives the request and pi tracks its own
				// usage. We only return a non-zero value so the UI's context-window
				// widget has something sensible to display.
				if (typeof text === 'string') {
					return Math.ceil(text.length / 4);
				}
				let chars = 0;
				for (const part of text.content) {
					if (typeof part === 'string') {
						chars += part.length;
					} else if (part && typeof (part as { value?: unknown }).value === 'string') {
						chars += ((part as { value: string }).value).length;
					}
				}
				return Math.ceil(chars / 4);
			},
		};
		this._register(lm.registerLanguageModelChatProvider(PiSessionUri.scheme, provider));
	}
}
