/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GtClient } from '../gtClient';
import type { GtEscalation, EscalationType, EscalationSeverity } from '../cli/contracts';

export class EscalationsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private previousIds = new Set<string>();

	constructor(private readonly client: GtClient) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
		if (element instanceof EscalationGroupItem) {
			return element.escalations
				.sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
				.map(e => new EscalationTreeItem(e));
		}

		const escalations = await this.client.getEscalations();

		// Notify on new critical escalations
		const newCritical = escalations.filter(
			e => !e.resolved && e.severity === 'critical' && !this.previousIds.has(e.id),
		);
		for (const e of newCritical) {
			vscode.window.showWarningMessage(`Critical escalation: ${e.title}`, 'Resolve').then(action => {
				if (action === 'Resolve') {
					vscode.commands.executeCommand('citadel.resolveEscalation', e);
				}
			});
		}
		this.previousIds = new Set(escalations.map(e => e.id));

		const unresolved = escalations.filter(e => !e.resolved);
		if (unresolved.length === 0) {
			const item = new vscode.TreeItem('No escalations');
			item.iconPath = new vscode.ThemeIcon('check');
			return [item];
		}

		const byType = new Map<EscalationType, GtEscalation[]>();
		for (const e of unresolved) {
			if (!byType.has(e.type)) { byType.set(e.type, []); }
			byType.get(e.type)!.push(e);
		}

		if (byType.size === 1) {
			return unresolved
				.sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
				.map(e => new EscalationTreeItem(e));
		}

		return Array.from(byType.entries()).map(
			([type, items]) => new EscalationGroupItem(type, items),
		);
	}
}

function severityRank(s: EscalationSeverity): number {
	switch (s) {
		case 'critical': return 4;
		case 'high': return 3;
		case 'medium': return 2;
		case 'low': return 1;
	}
}

class EscalationGroupItem extends vscode.TreeItem {
	constructor(
		public readonly escalationType: EscalationType,
		public readonly escalations: GtEscalation[],
	) {
		const labels: Record<EscalationType, string> = {
			decision: 'Decisions',
			conflict: 'Merge Conflicts',
			failure: 'Failures',
		};
		super(labels[escalationType] || escalationType, vscode.TreeItemCollapsibleState.Expanded);
		this.contextValue = 'escalationGroup';
		this.description = `${escalations.length}`;
		this.iconPath = EscalationGroupItem.getGroupIcon(escalationType);
	}

	private static getGroupIcon(type: EscalationType): vscode.ThemeIcon {
		switch (type) {
			case 'decision':
				return new vscode.ThemeIcon('question');
			case 'conflict':
				return new vscode.ThemeIcon('git-compare');
			case 'failure':
				return new vscode.ThemeIcon('error');
		}
	}
}

export class EscalationTreeItem extends vscode.TreeItem {
	constructor(public readonly escalation: GtEscalation) {
		super(escalation.title, vscode.TreeItemCollapsibleState.None);

		this.contextValue = escalation.agent ? 'escalationWithAgent' : 'escalation';
		this.description = `${escalation.severity} · ${escalation.type}`;
		this.tooltip = EscalationTreeItem.buildTooltip(escalation);
		this.iconPath = EscalationTreeItem.getIcon(escalation.severity);

		if (escalation.agent) {
			this.command = {
				command: 'citadel.openEscalationTerminal',
				title: 'Open Agent Terminal',
				arguments: [escalation],
			};
		} else {
			this.command = {
				command: 'citadel.resolveEscalation',
				title: 'Resolve Escalation',
				arguments: [escalation],
			};
		}
	}

	private static buildTooltip(e: GtEscalation): string {
		const lines = [e.title, '', e.description];
		if (e.agent) { lines.push(`Agent: ${e.agent}`); }
		if (e.rig) { lines.push(`Rig: ${e.rig}`); }
		if (e.bead_id) { lines.push(`Bead: ${e.bead_id}`); }
		lines.push('', e.agent ? 'Click to open agent terminal' : 'Click to resolve');
		return lines.join('\n');
	}

	private static getIcon(severity: EscalationSeverity): vscode.ThemeIcon {
		switch (severity) {
			case 'critical':
				return new vscode.ThemeIcon('flame', new vscode.ThemeColor('testing.iconFailed'));
			case 'high':
				return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
			case 'medium':
				return new vscode.ThemeIcon('info');
			case 'low':
				return new vscode.ThemeIcon('circle-outline');
		}
	}
}
