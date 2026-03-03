/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GtClient } from '../gtClient';
import type { GtEscalation } from '../cli/contracts';

export async function resolveEscalation(client: GtClient, escalation?: GtEscalation): Promise<void> {
	if (!escalation) {
		const all = await client.getEscalations();
		const unresolved = all.filter(e => !e.resolved);
		if (unresolved.length === 0) {
			vscode.window.showInformationMessage('No unresolved escalations.');
			return;
		}
		const selected = await vscode.window.showQuickPick(
			unresolved.map(e => ({
				label: e.title,
				description: `${e.severity} · ${e.type}`,
				detail: e.description,
				escalation: e,
			})),
			{ placeHolder: 'Select escalation to resolve' },
		);
		if (!selected) { return; }
		escalation = selected.escalation;
	}

	const decision = await vscode.window.showInputBox({
		prompt: `Resolution for: ${escalation.title}`,
		placeHolder: 'Describe your decision',
	});
	if (!decision) { return; }

	try {
		await client.resolveEscalation(escalation.id, decision);
		vscode.window.showInformationMessage(`Escalation resolved: ${escalation.title}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to resolve escalation: ${msg}`);
	}
}
