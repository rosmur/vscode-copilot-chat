/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { PiSessionUri } from '../pi/common/piSessionUri';
import { PiAgentManager } from '../pi/node/piCodeAgent';

/**
 * Bridges VS Code's chat session API to the pi agent manager.
 *
 * Phase 1 keeps this thin: no folder picker, no permission-mode UI, no
 * disk-backed history. `provideChatSessionContent` returns an empty session
 * shell; multi-turn memory is held in `PiAgentManager`'s in-memory map and
 * survives within a single VS Code window lifetime.
 */
export class PiChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {

	constructor(
		private readonly piAgentManager: PiAgentManager,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.logService.info('[PiChatSession] PiChatSessionContentProvider constructed');
	}

	createHandler(): ChatExtendedRequestHandler {
		this.logService.info('[PiChatSession] createHandler() called — chat participant request handler is bound');
		return async (request, context, stream, token) => {
			this.logService.info(`[PiChatSession] Request handler invoked. hasSessionContext=${!!context.chatSessionContext} model=${request.model?.id ?? '<none>'} prompt="${request.prompt.slice(0, 80)}"`);
			const { chatSessionContext } = context;
			if (!chatSessionContext) {
				this.logService.warn('[PiChatSession] No chatSessionContext — emitting "Start Session" button');
				stream.markdown(vscode.l10n.t('Start a new Pi Agent session.'));
				stream.button({
					command: `workbench.action.chat.openNewSessionEditor.${PiSessionUri.scheme}`,
					title: vscode.l10n.t('Start Session'),
				});
				return {};
			}

			const sessionId = PiSessionUri.getSessionId(chatSessionContext.chatSessionItem.resource);
			this.logService.info(`[PiChatSession] Routing to PiAgentManager for sessionId=${sessionId}`);
			return this.piAgentManager.handleRequest(sessionId, request, context, stream, token);
		};
	}

	async provideChatSessionContent(resource: vscode.Uri, _token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		this.logService.info(`[PiChatSession] provideChatSessionContent for ${resource.toString()}`);
		// MVP: empty shell. The agent manager owns conversation memory in process,
		// and on rehydration the chat panel hands the prior turns to us via
		// `context.history` on the next request — see PiCodeSession.seedHistory.
		return {
			history: [],
			activeResponseCallback: undefined,
			requestHandler: undefined,
		};
	}
}
