/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { INativeEnvService } from '../../../platform/env/common/envService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IPiAgentManager } from '../pi/node/piCodeAgent';

const PI_SESSION_SCHEME = 'pi-agent';

namespace PiSessionUri {
	export const scheme = PI_SESSION_SCHEME;

	export function forSessionId(sessionId: string): URI {
		return URI.from({ scheme: PI_SESSION_SCHEME, path: '/' + sessionId });
	}

	export function getSessionId(resource: URI): string {
		if (resource.scheme !== PI_SESSION_SCHEME) {
			throw new Error('Invalid resource scheme for Pi agent session');
		}
		return resource.path.slice(1);
	}
}

export class PiChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;

	private readonly _onDidChangeChatSessionProviderOptions = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionProviderOptions = this._onDidChangeChatSessionProviderOptions.event;

	private readonly _controller: vscode.ChatSessionItemController;

	constructor(
		@IPiAgentManager private readonly piAgentManager: IPiAgentManager,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INativeEnvService private readonly envService: INativeEnvService,
	) {
		super();

		this._controller = this._register(vscode.chat.createChatSessionItemController(
			PiSessionUri.scheme,
			() => Promise.resolve(), // no stored sessions to restore for MVP
		));

		this._controller.newChatSessionItemHandler = async (context, _token) => {
			const newSessionId = generateUuid();
			const item = this._controller.createChatSessionItem(
				PiSessionUri.forSessionId(newSessionId),
				context.request.prompt,
			);
			item.iconPath = new vscode.ThemeIcon('pi');
			item.timing = { created: Date.now() };
			return item;
		};

		// Listen for workspace folder changes to potentially update options
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._onDidChangeChatSessionProviderOptions.fire();
		}));
	}

	// #region Chat Participant Handler

	createHandler(): ChatExtendedRequestHandler {
		return async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> => {
			const { chatSessionContext } = context;
			if (!chatSessionContext) {
				stream.markdown(vscode.l10n.t('Start a new Pi Agent session to use pi.'));
				stream.button({ command: `workbench.action.chat.openNewSessionEditor.${PiSessionUri.scheme}`, title: vscode.l10n.t('Start Session') });
				return {};
			}

			const effectiveSessionId = PiSessionUri.getSessionId(chatSessionContext.chatSessionItem.resource);
			const cwd = await this._resolveCwd(effectiveSessionId);

			this._updateItemStatus(effectiveSessionId, vscode.ChatSessionStatus.InProgress, request.prompt);

			const isNewSession = !chatSessionContext.chatSessionItem.timing?.lastRequestEnded;
			const result = await this.piAgentManager.handleRequest(effectiveSessionId, request, stream, token, cwd, isNewSession);

			this._updateItemStatus(effectiveSessionId, vscode.ChatSessionStatus.Completed, request.prompt);
			return result;
		};
	}

	// #endregion

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		return { optionGroups: [], newSessionOptions: {} };
	}

	async provideHandleOptionsChange(_resource: vscode.Uri, _updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, _token: vscode.CancellationToken): Promise<void> {
		// No options to handle for MVP
	}

	async provideChatSessionContent(_sessionResource: vscode.Uri, _token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		return {
			title: undefined,
			history: [],
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options: {},
		};
	}

	private async _resolveCwd(sessionId: string): Promise<string> {
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length >= 1) {
			return workspaceFolders[0].fsPath;
		}
		return this.envService.userHome.fsPath;
	}

	private _updateItemStatus(sessionId: string, status: vscode.ChatSessionStatus, label: string): void {
		const resource = PiSessionUri.forSessionId(sessionId);
		let item = this._controller.items.get(resource);
		if (!item) {
			item = this._controller.createChatSessionItem(resource, label);
			item.iconPath = new vscode.ThemeIcon('pi');
			item.timing = { created: Date.now() };
			this._controller.items.add(item);
		}
		item.status = status;
		if (status === vscode.ChatSessionStatus.InProgress) {
			item.timing = { ...item.timing, created: item.timing?.created ?? Date.now(), lastRequestStarted: Date.now(), lastRequestEnded: undefined };
		} else if (status === vscode.ChatSessionStatus.Completed) {
			item.timing = { ...item.timing, created: item.timing?.created ?? Date.now(), lastRequestEnded: Date.now() };
		}
	}
}
