/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const HISTORY_HEADER = '[Continuing prior conversation. Earlier turns:]';
const MAX_TURNS = 20;
const MAX_TEXT_PER_TURN = 4000;

/**
 * VS Code rehydrates a session (e.g. after window reload) with a `history`
 * array but no SDK state. Pi's `AgentSession` is in-memory, so we must hand
 * the prior turns to the agent before processing the next user prompt.
 *
 * The cleanest approach — mutating `session.agent.state.messages` — would
 * couple us to pi-ai's internal `AgentMessage` shape. Instead we serialise
 * the recent history into a plain-text preamble that is prepended to the
 * next user prompt as a single block. The agent treats it as context.
 *
 * Returns `undefined` when there's nothing useful to replay.
 */
export function formatHistoryAsContext(
	history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
): string | undefined {
	if (history.length === 0) {
		return undefined;
	}

	const recent = history.slice(-MAX_TURNS);
	const lines: string[] = [HISTORY_HEADER];
	for (const turn of recent) {
		if (turn instanceof vscode.ChatRequestTurn) {
			const text = truncate(turn.prompt, MAX_TEXT_PER_TURN);
			if (text) {
				lines.push(`User: ${text}`);
			}
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const text = truncate(extractAssistantText(turn), MAX_TEXT_PER_TURN);
			if (text) {
				lines.push(`Assistant: ${text}`);
			}
		}
	}

	return lines.length > 1 ? lines.join('\n\n') : undefined;
}

function extractAssistantText(turn: vscode.ChatResponseTurn): string {
	const parts: string[] = [];
	for (const part of turn.response) {
		if (part instanceof vscode.ChatResponseMarkdownPart) {
			parts.push(part.value.value);
		}
	}
	return parts.join('');
}

function truncate(s: string, max: number): string {
	const trimmed = s.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return trimmed.slice(0, max) + '… [truncated]';
}
