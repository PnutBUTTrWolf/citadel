/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TerminalManager } from '../terminalManager';
import type { AgentDisplayStatus } from '../constants';

export interface ConvoyProgressInfo {
	convoyId: string;
	convoyTitle: string;
	completed: number;
	total: number;
}

export interface BattlestationPaneInfo {
	agentName: string;
	label: string;
	group: string;
	slot: number;
	status: AgentDisplayStatus;
	paneId?: number;
	focused: boolean;
	role: string;
	rig: string;
	beadId?: string;
	running: boolean;
	convoy?: ConvoyProgressInfo;
	terminalOutput?: string;
}

export class BattlestationPanel {
	private static instance: BattlestationPanel | undefined;
	private panel: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private activeFilter: { type: string; value: string } | undefined;

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly terminalManager: TerminalManager,
	) {
		this.panel = panel;

		this.panel.webview.onDidReceiveMessage(
			(msg) => this.handleMessage(msg),
			undefined,
			this.disposables,
		);

		this.panel.onDidDispose(
			() => this.dispose(),
			undefined,
			this.disposables,
		);

		// Listen for terminal count changes to auto-refresh
		this.disposables.push(
			this.terminalManager.onDidTerminalCountChange(() => this.refresh()),
		);

		// Periodic refresh to catch status changes (configurable)
		const interval = vscode.workspace.getConfiguration('citadel')
			.get<number>('battlestation.refreshInterval', 3000);
		this.refreshTimer = setInterval(() => this.refresh(), interval);

		// Set the skeleton HTML once, then use postMessage for updates
		this.panel.webview.html = this.getSkeletonHtml();
		this.refresh();
	}

	static createOrShow(
		_extensionUri: vscode.Uri,
		terminalManager: TerminalManager,
	): BattlestationPanel {
		if (BattlestationPanel.instance) {
			BattlestationPanel.instance.panel.reveal(vscode.ViewColumn.One);
			BattlestationPanel.instance.refresh();
			return BattlestationPanel.instance;
		}

		const panel = vscode.window.createWebviewPanel(
			'citadel.battlestation',
			'Battlestation',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);
		panel.iconPath = new vscode.ThemeIcon('layout');

		BattlestationPanel.instance = new BattlestationPanel(panel, terminalManager);
		return BattlestationPanel.instance;
	}

	static get current(): BattlestationPanel | undefined {
		return BattlestationPanel.instance;
	}

	refresh(): void {
		const allPanes = this.terminalManager.getBattlestationState();
		let panes = allPanes;
		if (this.activeFilter) {
			const { type, value } = this.activeFilter;
			panes = panes.filter(p =>
				type === 'rig' ? p.rig === value : p.role === value,
			);
		}

		// Collect filter options from all panes (unfiltered)
		const rigs = [...new Set(allPanes.map(p => p.rig).filter(Boolean))].sort();
		const roles = [...new Set(allPanes.map(p => p.role).filter(Boolean))].sort();
		const hasCompleted = allPanes.some(p =>
			p.status === 'completing' || p.status === 'exited' || p.status === 'dead',
		);

		// Enrich with convoy progress and terminal output asynchronously
		Promise.all([
			this.terminalManager.getConvoyProgressMap().catch(() => new Map()),
			this.terminalManager.captureTmuxOutputs().catch(() => new Map()),
		]).then(([convoyMap, outputMap]) => {
			for (const pane of panes) {
				if (pane.beadId && convoyMap.has(pane.beadId)) {
					pane.convoy = convoyMap.get(pane.beadId);
				}
				if (outputMap.has(pane.agentName)) {
					pane.terminalOutput = outputMap.get(pane.agentName);
				}
			}
			this.panel.webview.postMessage({
				command: 'updatePanes',
				panes: panes.map(p => ({
					agentName: p.agentName,
					label: p.label,
					group: p.group,
					slot: p.slot,
					status: p.status,
					focused: p.focused,
					role: p.role,
					rig: p.rig,
					beadId: p.beadId,
					running: p.running,
					convoy: p.convoy,
					terminalOutput: p.terminalOutput,
				})),
				paneCount: panes.length,
				hasFilter: !!this.activeFilter,
				rigs,
				roles,
				hasCompleted,
				activeFilter: this.activeFilter,
			});
		});
	}

	private handleMessage(msg: { command: string; agentName?: string; role?: string; rig?: string; beadId?: string; filterType?: string; filterValue?: string }): void {
		switch (msg.command) {
			case 'focusPane':
				if (msg.agentName) {
					this.terminalManager.showAgentTerminal(msg.agentName);
					const paneId = this.terminalManager.getPaneId(msg.agentName);
					if (paneId !== undefined) {
						vscode.commands.executeCommand('battlestation.focusPane', paneId);
					}
				}
				break;
			case 'closePane':
				if (msg.agentName) {
					this.terminalManager.closeAgentTerminal(msg.agentName);
					this.refresh();
				}
				break;
			case 'reconnectPane':
				if (msg.agentName) {
					vscode.commands.executeCommand('citadel.reconnectTerminal', { agent: { name: msg.agentName } });
				}
				break;
			case 'revealAgent':
				if (msg.agentName) {
					vscode.commands.executeCommand('citadel.agents.focus');
				}
				break;
			case 'killAgent':
				if (msg.agentName) {
					vscode.commands.executeCommand('citadel.killAgent', {
						agent: { name: msg.agentName, role: msg.role, rig: msg.rig },
					});
				}
				break;
			case 'restartAgent':
				if (msg.agentName) {
					vscode.commands.executeCommand('citadel.restartAgent', {
						agent: { name: msg.agentName, role: msg.role, rig: msg.rig },
					});
				}
				break;
			case 'viewBead':
				if (msg.beadId) {
					vscode.commands.executeCommand('citadel.showBead', { bead: { id: msg.beadId } });
				}
				break;
			case 'clearCompleted':
				this.clearCompletedPanes();
				break;
			case 'setFilter':
				this.activeFilter = msg.filterType && msg.filterValue
					? { type: msg.filterType, value: msg.filterValue }
					: undefined;
				this.refresh();
				break;
		}
	}

	private clearCompletedPanes(): void {
		const panes = this.terminalManager.getBattlestationState();
		const completed = panes.filter(p =>
			p.status === 'completing' || p.status === 'exited' || p.status === 'dead',
		);
		for (const pane of completed) {
			this.terminalManager.closeAgentTerminal(pane.agentName);
		}
		this.refresh();
	}

	private getSkeletonHtml(): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	:root {
		--grid-cols: 1;
	}
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
		font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 16px;
		height: 100vh;
		overflow: auto;
	}
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
	}
	.header h1 {
		font-size: 16px;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.header .stats {
		font-size: 12px;
		color: var(--vscode-descriptionForeground);
	}
	.quick-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
		padding: 6px 8px;
		background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.1));
		border-radius: 4px;
		flex-wrap: wrap;
	}
	.quick-bar label {
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		font-weight: 500;
	}
	.quick-bar select {
		font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
		font-size: 11px;
		color: var(--vscode-foreground);
		background: var(--vscode-input-background, rgba(60,60,60,0.8));
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
		border-radius: 3px;
		padding: 2px 6px;
		outline: none;
	}
	.quick-bar select:focus {
		border-color: var(--vscode-focusBorder);
	}
	.quick-bar .separator {
		width: 1px;
		height: 16px;
		background: var(--vscode-panel-border, rgba(128,128,128,0.3));
	}
	.quick-bar button {
		font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
		font-size: 11px;
		color: var(--vscode-foreground);
		background: var(--vscode-button-secondaryBackground, rgba(80,80,80,0.6));
		border: none;
		border-radius: 3px;
		padding: 3px 8px;
		cursor: pointer;
	}
	.quick-bar button:hover {
		background: var(--vscode-button-secondaryHoverBackground, rgba(100,100,100,0.6));
	}
	.quick-bar button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 60vh;
		color: var(--vscode-descriptionForeground);
		gap: 12px;
	}
	.empty-state .icon {
		font-size: 48px;
		opacity: 0.4;
	}
	.empty-state p {
		font-size: 14px;
		text-align: center;
		max-width: 300px;
		line-height: 1.5;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(var(--grid-cols), 1fr);
		gap: 12px;
		height: calc(100vh - 120px);
	}
	.pane {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
		border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
		border-radius: 6px;
		background: var(--vscode-sideBar-background, rgba(30,30,30,0.5));
		overflow: hidden;
		cursor: pointer;
		transition: border-color 0.15s, box-shadow 0.15s;
		min-height: 120px;
		position: relative;
	}
	.pane:hover {
		border-color: var(--vscode-focusBorder);
	}
	.pane.focused {
		border-color: var(--vscode-focusBorder);
		box-shadow: 0 0 0 1px var(--vscode-focusBorder);
	}
	.pane.state-running { border-left-color: var(--vscode-testing-runAction, #89d185); }
	.pane.state-completing { border-left-color: var(--vscode-testing-iconPassed, #4ec9b0); }
	.pane.state-stuck { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
	.pane.state-dead { border-left-color: var(--vscode-testing-iconFailed, #f14c4c); }
	.pane.state-idle { border-left-color: var(--vscode-disabledForeground, #888); }
	.pane.state-exited { border-left-color: var(--vscode-disabledForeground, #888); }
	.pane-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.1));
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
		gap: 8px;
	}
	.pane-header-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		flex: 1;
	}
	.pane-status {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.pane-status.running {
		background: var(--vscode-testing-runAction, #89d185);
		animation: pulse 2s ease-in-out infinite;
	}
	.pane-status.idle { background: var(--vscode-disabledForeground, #888); }
	.pane-status.completing { background: var(--vscode-testing-iconPassed, #4ec9b0); }
	.pane-status.stuck {
		background: var(--vscode-editorWarning-foreground, #cca700);
		animation: pulse 1.5s ease-in-out infinite;
	}
	.pane-status.dead { background: var(--vscode-testing-iconFailed, #f14c4c); }
	.pane-status.exited { background: var(--vscode-disabledForeground, #888); }
	@keyframes pulse {
		0%, 100% { opacity: 1; box-shadow: 0 0 0 0 currentColor; }
		50% { opacity: 0.6; box-shadow: 0 0 4px 2px currentColor; }
	}
	.pane-name {
		font-weight: 600;
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pane-group {
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		padding: 2px 6px;
		background: var(--vscode-badge-background, rgba(128,128,128,0.2));
		border-radius: 3px;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.pane-body {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		position: relative;
	}
	.pane-terminal {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 6px 8px;
		font-family: var(--vscode-editor-font-family, 'Menlo', 'Monaco', 'Courier New', monospace);
		font-size: 11px;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-all;
		color: var(--vscode-terminal-foreground, var(--vscode-foreground));
		background: var(--vscode-terminal-background, rgba(0,0,0,0.2));
	}
	.pane-terminal::-webkit-scrollbar {
		width: 10px;
	}
	.pane-terminal::-webkit-scrollbar-track {
		background: transparent;
	}
	.pane-terminal::-webkit-scrollbar-thumb {
		background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4));
		border-radius: 5px;
		border: 2px solid transparent;
		background-clip: content-box;
	}
	.pane-terminal::-webkit-scrollbar-thumb:hover {
		background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.7));
		background-clip: content-box;
	}
	.pane-terminal::-webkit-scrollbar-thumb:active {
		background: var(--vscode-scrollbarSlider-activeBackground, rgba(191,191,191,0.4));
		background-clip: content-box;
	}
	.pane-terminal-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--vscode-descriptionForeground);
		font-size: 11px;
		opacity: 0.7;
		text-align: center;
		line-height: 1.5;
	}
	.pane-actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}
	.pane-actions button {
		background: none;
		border: none;
		color: var(--vscode-descriptionForeground);
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 3px;
		font-size: 12px;
		line-height: 1;
	}
	.pane-actions button:hover {
		background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
		color: var(--vscode-foreground);
	}
	.pane-slot {
		font-size: 10px;
		font-weight: 700;
		color: var(--vscode-descriptionForeground);
		opacity: 0.6;
		width: 18px;
		height: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 3px;
		background: var(--vscode-badge-background, rgba(128,128,128,0.2));
		flex-shrink: 0;
	}
	.status-label {
		font-size: 13px;
		font-weight: 500;
	}
	.status-label.running { color: var(--vscode-testing-runAction, #89d185); }
	.status-label.completing { color: var(--vscode-testing-iconPassed, #4ec9b0); }
	.status-label.stuck { color: var(--vscode-editorWarning-foreground, #cca700); }
	.status-label.dead { color: var(--vscode-testing-iconFailed, #f14c4c); }
	.status-label.exited, .status-label.idle { color: var(--vscode-disabledForeground, #888); }
	.bead-badge {
		font-size: 10px;
		font-family: var(--vscode-editor-font-family, monospace);
		color: var(--vscode-badge-foreground, #fff);
		background: var(--vscode-badge-background, rgba(128,128,128,0.3));
		padding: 1px 6px;
		border-radius: 3px;
		white-space: nowrap;
		flex-shrink: 0;
		max-width: 100px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.convoy-progress {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 3px;
		background: var(--vscode-panel-border, rgba(128,128,128,0.2));
		overflow: hidden;
	}
	.convoy-progress-bar {
		height: 100%;
		background: var(--vscode-progressBar-background, #0078d4);
		transition: width 0.3s ease;
	}
	.convoy-label {
		font-size: 10px;
		color: var(--vscode-descriptionForeground);
		padding: 0 12px 6px;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.convoy-label .progress-text {
		font-family: var(--vscode-editor-font-family, monospace);
	}
	/* Context menu */
	.ctx-menu {
		position: fixed;
		z-index: 1000;
		min-width: 160px;
		background: var(--vscode-menu-background, #2d2d2d);
		border: 1px solid var(--vscode-menu-border, rgba(128,128,128,0.4));
		border-radius: 4px;
		box-shadow: 0 4px 12px rgba(0,0,0,0.3);
		padding: 4px 0;
		display: none;
	}
	.ctx-menu.visible { display: block; }
	.ctx-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		font-size: 12px;
		color: var(--vscode-menu-foreground, var(--vscode-foreground));
		cursor: pointer;
		white-space: nowrap;
	}
	.ctx-menu-item:hover {
		background: var(--vscode-menu-selectionBackground, var(--vscode-focusBorder));
		color: var(--vscode-menu-selectionForeground, #fff);
	}
	.ctx-menu-item.disabled {
		opacity: 0.5;
		cursor: default;
	}
	.ctx-menu-item.disabled:hover {
		background: none;
		color: var(--vscode-menu-foreground, var(--vscode-foreground));
	}
	.ctx-menu-item .icon {
		width: 14px;
		text-align: center;
		flex-shrink: 0;
	}
	.ctx-menu-separator {
		height: 1px;
		background: var(--vscode-menu-separatorBackground, rgba(128,128,128,0.3));
		margin: 4px 8px;
	}
</style>
</head>
<body>
	<div class="header">
		<h1>Battlestation</h1>
		<span class="stats" id="stats-label">0 terminals</span>
	</div>
	<div class="quick-bar">
		<label>Filter:</label>
		<select id="filter-rig">
			<option value="">All rigs</option>
		</select>
		<select id="filter-role">
			<option value="">All roles</option>
		</select>
		<div class="separator"></div>
		<button id="btn-clear-completed" disabled>Clear completed</button>
	</div>
	<div id="content-area">
		<div class="empty-state">
			<div class="icon">&#x25A3;</div>
			<p>No agent terminals open.<br>Click an agent in the sidebar or sling a bead to populate the grid.</p>
		</div>
	</div>
	<div class="ctx-menu" id="context-menu"></div>
	<script>
		const vscode = acquireVsCodeApi();

		// Track which panes the user has manually scrolled (not at bottom)
		const userScrolled = {};

		function escapeHtml(text) {
			const el = document.createElement('span');
			el.textContent = text;
			return el.innerHTML;
		}

		function stripAnsi(text) {
			// eslint-disable-next-line no-control-regex
			return text.replace(/\\x1b\\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\\[[0-9;]*[a-zA-Z]/g, '');
		}

		function statusText(s) {
			switch(s) {
				case 'running': return 'Running';
				case 'completing': return 'Completing';
				case 'stuck': return 'Stuck';
				case 'dead': return 'Dead';
				case 'exited': return 'Exited';
				case 'idle': return 'Idle';
				default: return s;
			}
		}

		function computeCols(count) {
			if (count <= 1) return 1;
			if (count <= 4) return 2;
			if (count <= 6) return 3;
			return Math.min(4, Math.ceil(Math.sqrt(count)));
		}

		function buildPaneHtml(p) {
			const focusedClass = p.focused ? ' focused' : '';
			const stateClass = ' state-' + p.status;
			const beadBadge = p.beadId
				? '<div class="bead-badge" title="' + escapeHtml(p.beadId) + '">' + escapeHtml(p.beadId) + '</div>'
				: '';
			const groupBadge = p.group
				? '<div class="pane-group">' + escapeHtml(p.group) + '</div>'
				: '';

			let bodyContent;
			if (p.terminalOutput) {
				bodyContent = '<div class="pane-terminal" data-terminal="' + escapeHtml(p.agentName) + '">'
					+ escapeHtml(stripAnsi(p.terminalOutput))
					+ '</div>';
			} else {
				bodyContent = '<div class="pane-terminal-empty">'
					+ '<span class="status-label ' + p.status + '">' + statusText(p.status) + '</span><br>'
					+ 'Click to focus terminal'
					+ '</div>';
			}

			let convoyHtml = '';
			if (p.convoy) {
				const pct = p.convoy.total > 0
					? Math.round((p.convoy.completed / p.convoy.total) * 100)
					: 0;
				convoyHtml = '<div class="convoy-label">'
					+ '<span class="progress-text">' + p.convoy.completed + '/' + p.convoy.total + '</span>'
					+ escapeHtml(p.convoy.convoyTitle)
					+ '</div>'
					+ '<div class="convoy-progress">'
					+ '<div class="convoy-progress-bar" style="width: ' + pct + '%"></div>'
					+ '</div>';
			}

			return '<div class="pane' + focusedClass + stateClass + '"'
				+ ' data-agent="' + escapeHtml(p.agentName) + '"'
				+ ' data-role="' + escapeHtml(p.role) + '"'
				+ ' data-rig="' + escapeHtml(p.rig) + '"'
				+ ' data-bead="' + escapeHtml(p.beadId || '') + '"'
				+ ' data-running="' + p.running + '"'
				+ ' data-status="' + p.status + '">'
				+ '<div class="pane-header">'
				+ '<div class="pane-header-left">'
				+ '<div class="pane-slot">' + (p.slot + 1) + '</div>'
				+ '<div class="pane-status ' + p.status + '"></div>'
				+ '<div class="pane-name" title="' + escapeHtml(p.label) + '">' + escapeHtml(p.label) + '</div>'
				+ beadBadge
				+ '</div>'
				+ groupBadge
				+ '<div class="pane-actions">'
				+ '<button class="btn-reveal" data-agent="' + escapeHtml(p.agentName) + '" title="Reveal in sidebar">&#x1F50D;</button>'
				+ '<button class="btn-reconnect" data-agent="' + escapeHtml(p.agentName) + '" title="Reconnect">&#x21BB;</button>'
				+ '<button class="btn-close" data-agent="' + escapeHtml(p.agentName) + '" title="Close">&#x2715;</button>'
				+ '</div>'
				+ '</div>'
				+ '<div class="pane-body">' + bodyContent + '</div>'
				+ convoyHtml
				+ '</div>';
		}

		function bindPaneEvents() {
			// Pane click to focus terminal
			document.querySelectorAll('.pane[data-agent]').forEach(el => {
				el.addEventListener('click', (e) => {
					if (e.target.closest('.pane-actions button')) return;
					if (e.target.closest('.pane-terminal')) return; // Don't focus on terminal scroll
					vscode.postMessage({ command: 'focusPane', agentName: el.dataset.agent });
				});
			});

			// Double-click on terminal area to focus
			document.querySelectorAll('.pane-terminal').forEach(el => {
				el.addEventListener('dblclick', () => {
					const pane = el.closest('.pane[data-agent]');
					if (pane) {
						vscode.postMessage({ command: 'focusPane', agentName: pane.dataset.agent });
					}
				});
			});

			// Action buttons
			document.querySelectorAll('.btn-close').forEach(el => {
				el.addEventListener('click', () => {
					vscode.postMessage({ command: 'closePane', agentName: el.dataset.agent });
				});
			});
			document.querySelectorAll('.btn-reconnect').forEach(el => {
				el.addEventListener('click', () => {
					vscode.postMessage({ command: 'reconnectPane', agentName: el.dataset.agent });
				});
			});
			document.querySelectorAll('.btn-reveal').forEach(el => {
				el.addEventListener('click', () => {
					vscode.postMessage({ command: 'revealAgent', agentName: el.dataset.agent });
				});
			});

			// Track manual scrolling on terminal areas
			document.querySelectorAll('.pane-terminal').forEach(el => {
				el.addEventListener('scroll', () => {
					const agent = el.dataset.terminal;
					const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
					userScrolled[agent] = !isAtBottom;
				});
			});

			// Context menu
			document.querySelectorAll('.pane[data-agent]').forEach(el => {
				el.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					const agent = el.dataset.agent;
					const role = el.dataset.role || '';
					const rig = el.dataset.rig || '';
					const beadId = el.dataset.bead || '';
					const running = el.dataset.running === 'true';
					const status = el.dataset.status || '';

					const items = [];
					items.push({ icon: '&#x25CF;', label: statusText(status), disabled: true });
					items.push({ separator: true });
					items.push({ icon: '&#x1F4CB;', label: 'View Bead', action: 'viewBead', disabled: !beadId, data: { beadId } });
					items.push({ icon: '&#x1F50D;', label: 'Reveal in Sidebar', action: 'revealAgent', data: { agentName: agent } });
					items.push({ separator: true });
					items.push({ icon: '&#x21BB;', label: 'Reconnect', action: 'reconnectPane', data: { agentName: agent } });
					items.push({ icon: '&#x27F3;', label: 'Restart', action: 'restartAgent', disabled: !running, data: { agentName: agent, role, rig } });
					items.push({ separator: true });
					items.push({ icon: '&#x2715;', label: 'Kill Agent', action: 'killAgent', data: { agentName: agent, role, rig } });

					const ctxMenu = document.getElementById('context-menu');
					ctxMenu.innerHTML = items.map(item => {
						if (item.separator) return '<div class="ctx-menu-separator"></div>';
						const cls = ['ctx-menu-item'];
						if (item.disabled) cls.push('disabled');
						return '<div class="' + cls.join(' ') + '"'
							+ (item.action && !item.disabled ? ' data-action="' + item.action + '"' : '')
							+ (item.data ? " data-payload='" + JSON.stringify(item.data).replace(/'/g, '&#39;') + "'" : '')
							+ '><span class="icon">' + item.icon + '</span>' + item.label + '</div>';
					}).join('');

					const x = Math.min(e.clientX, window.innerWidth - 180);
					const y = Math.min(e.clientY, window.innerHeight - (items.length * 30));
					ctxMenu.style.left = x + 'px';
					ctxMenu.style.top = y + 'px';
					ctxMenu.classList.add('visible');

					ctxMenu.querySelectorAll('.ctx-menu-item[data-action]').forEach(mi => {
						mi.addEventListener('click', (ev) => {
							ev.stopPropagation();
							const payload = mi.dataset.payload ? JSON.parse(mi.dataset.payload) : {};
							vscode.postMessage({ command: mi.dataset.action, ...payload });
							hideCtxMenu();
						});
					});
				});
			});
		}

		// --- Quick bar ---
		document.getElementById('filter-rig').addEventListener('change', (e) => {
			const val = e.target.value;
			document.getElementById('filter-role').value = '';
			vscode.postMessage({
				command: 'setFilter',
				filterType: val ? 'rig' : undefined,
				filterValue: val || undefined,
			});
		});
		document.getElementById('filter-role').addEventListener('change', (e) => {
			const val = e.target.value;
			document.getElementById('filter-rig').value = '';
			vscode.postMessage({
				command: 'setFilter',
				filterType: val ? 'role' : undefined,
				filterValue: val || undefined,
			});
		});
		document.getElementById('btn-clear-completed').addEventListener('click', () => {
			vscode.postMessage({ command: 'clearCompleted' });
		});

		// --- Context menu dismiss ---
		const ctxMenu = document.getElementById('context-menu');
		function hideCtxMenu() {
			ctxMenu.classList.remove('visible');
		}
		document.addEventListener('click', hideCtxMenu);
		document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

		// --- Handle updates from extension ---
		let currentPaneNames = new Set();

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.command !== 'updatePanes') return;

			const { panes, paneCount, hasFilter, rigs, roles, hasCompleted, activeFilter } = msg;

			// Update filter dropdowns
			const rigSelect = document.getElementById('filter-rig');
			const roleSelect = document.getElementById('filter-role');
			if (rigs) {
				const rigVal = rigSelect.value;
				rigSelect.innerHTML = '<option value="">All rigs</option>'
					+ (rigs || []).map(r => '<option value="' + escapeHtml(r) + '"'
						+ (activeFilter && activeFilter.type === 'rig' && activeFilter.value === r ? ' selected' : '')
						+ '>' + escapeHtml(r) + '</option>').join('');
				if (!activeFilter) rigSelect.value = rigVal || '';
			}
			if (roles) {
				const roleVal = roleSelect.value;
				roleSelect.innerHTML = '<option value="">All roles</option>'
					+ (roles || []).map(r => '<option value="' + escapeHtml(r) + '"'
						+ (activeFilter && activeFilter.type === 'role' && activeFilter.value === r ? ' selected' : '')
						+ '>' + escapeHtml(r) + '</option>').join('');
				if (!activeFilter) roleSelect.value = roleVal || '';
			}
			document.getElementById('btn-clear-completed').disabled = !hasCompleted;

			// Update stats
			document.getElementById('stats-label').textContent =
				paneCount + ' terminal' + (paneCount !== 1 ? 's' : '') + (hasFilter ? ' (filtered)' : '');

			const contentArea = document.getElementById('content-area');
			const newPaneNames = new Set(panes.map(p => p.agentName));

			// Check if pane set changed (add/remove) requiring full rebuild
			const setChanged = newPaneNames.size !== currentPaneNames.size
				|| [...newPaneNames].some(n => !currentPaneNames.has(n));

			if (paneCount === 0) {
				contentArea.innerHTML = '<div class="empty-state">'
					+ '<div class="icon">&#x25A3;</div>'
					+ '<p>' + (hasFilter
						? 'No terminals match the current filter.'
						: 'No agent terminals open.<br>Click an agent in the sidebar or sling a bead to populate the grid.')
					+ '</p></div>';
				currentPaneNames = newPaneNames;
				return;
			}

			if (setChanged) {
				// Full rebuild of the grid
				const cols = computeCols(paneCount);
				document.documentElement.style.setProperty('--grid-cols', cols);
				contentArea.innerHTML = '<div class="grid">'
					+ panes.map(p => buildPaneHtml(p)).join('')
					+ '</div>';
				currentPaneNames = newPaneNames;
				bindPaneEvents();

				// Auto-scroll all terminals to bottom on first render
				document.querySelectorAll('.pane-terminal').forEach(el => {
					el.scrollTop = el.scrollHeight;
				});
				return;
			}

			// Incremental update: update terminal content and status in-place
			for (const p of panes) {
				const paneEl = contentArea.querySelector('.pane[data-agent="' + CSS.escape(p.agentName) + '"]');
				if (!paneEl) continue;

				// Update status classes
				paneEl.className = 'pane' + (p.focused ? ' focused' : '') + ' state-' + p.status;
				paneEl.dataset.status = p.status;
				paneEl.dataset.running = String(p.running);
				paneEl.dataset.bead = p.beadId || '';

				// Update status indicator
				const statusDot = paneEl.querySelector('.pane-status');
				if (statusDot) statusDot.className = 'pane-status ' + p.status;

				// Update terminal output
				const termEl = paneEl.querySelector('.pane-terminal');
				const bodyEl = paneEl.querySelector('.pane-body');
				if (p.terminalOutput) {
					const cleanOutput = escapeHtml(stripAnsi(p.terminalOutput));
					if (termEl) {
						// Check if content actually changed
						if (termEl.innerHTML !== cleanOutput) {
							termEl.innerHTML = cleanOutput;
							// Auto-scroll to bottom unless user manually scrolled up
							if (!userScrolled[p.agentName]) {
								termEl.scrollTop = termEl.scrollHeight;
							}
						}
					} else {
						// Replace empty state with terminal content
						bodyEl.innerHTML = '<div class="pane-terminal" data-terminal="'
							+ escapeHtml(p.agentName) + '">' + cleanOutput + '</div>';
						const newTermEl = bodyEl.querySelector('.pane-terminal');
						newTermEl.scrollTop = newTermEl.scrollHeight;
						// Re-bind scroll tracking
						newTermEl.addEventListener('scroll', () => {
							const isAtBottom = newTermEl.scrollHeight - newTermEl.scrollTop - newTermEl.clientHeight < 20;
							userScrolled[p.agentName] = !isAtBottom;
						});
						newTermEl.addEventListener('dblclick', () => {
							vscode.postMessage({ command: 'focusPane', agentName: p.agentName });
						});
					}
				} else if (!termEl && bodyEl) {
					bodyEl.innerHTML = '<div class="pane-terminal-empty">'
						+ '<span class="status-label ' + p.status + '">' + statusText(p.status) + '</span><br>'
						+ 'Click to focus terminal'
						+ '</div>';
				}

				// Update convoy progress
				const existingConvoyLabel = paneEl.querySelector('.convoy-label');
				const existingConvoyBar = paneEl.querySelector('.convoy-progress');
				if (p.convoy) {
					const pct = p.convoy.total > 0
						? Math.round((p.convoy.completed / p.convoy.total) * 100)
						: 0;
					if (existingConvoyBar) {
						existingConvoyBar.querySelector('.convoy-progress-bar').style.width = pct + '%';
						existingConvoyLabel.querySelector('.progress-text').textContent =
							p.convoy.completed + '/' + p.convoy.total;
					}
				}
			}
		});
	</script>
</body>
</html>`;
	}

	private dispose(): void {
		BattlestationPanel.instance = undefined;
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}
}
