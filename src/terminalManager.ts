/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { GtClient, GtAgent, DaemonIssue } from './gtClient';
import { RIG_COLORS, INFRASTRUCTURE_ROLES, type AgentDisplayStatus } from './constants';

function issueLabel(issue: DaemonIssue): string {
	switch (issue.kind) {
		case 'not-running':
			return 'Daemon is not running';
		case 'stale-heartbeat':
			return `Daemon heartbeat is stale (${issue.age} old)`;
		case 'crash-loop':
			return `${issue.agent} is in a crash loop (${issue.restartCount} restarts)`;
		case 'stale-agent-config':
			return `Agent config references missing file: ${issue.command}`;
	}
}

/**
 * Tracks the lifecycle state of a single agent terminal.
 */
interface AgentTerminalState {
	agent: GtAgent;
	terminal: vscode.Terminal;
	status: AgentDisplayStatus;
	/** Grid slot index for reflow (0-based) */
	slot: number;
	/** Battlestation pane ID (if registered) */
	paneId?: number;
}

/**
 * Serializable layout entry persisted to workspaceState.
 * Captures enough info to restore terminals and reconnect tmux sessions.
 */
interface PersistedPaneEntry {
	agentName: string;
	rig: string;
	role: string;
	session?: string;
	beadId?: string;
	slot: number;
}

const LAYOUT_STORAGE_KEY = 'citadel.battlestation.layout';

/**
 * TerminalManager handles the full lifecycle of agent terminals:
 *
 * 1. Auto-add polecat terminals on sling
 * 2. Mark terminals done on agent completion
 * 3. Reconnect tmux sessions for running agents
 * 4. Grid reflow when terminals close
 */
export class TerminalManager {
	private agentTerminals = new Map<string, vscode.Terminal>();
	private rigColorMap = new Map<string, vscode.ThemeColor>();
	private colorIndex = 0;

	/** Lifecycle state tracking for each agent terminal */
	private terminalStates = new Map<string, AgentTerminalState>();
	/** Previous agent status snapshot for detecting transitions */
	private previousAgentStatus = new Map<string, AgentDisplayStatus>();
	/** Pending sling watchers (beadId -> timer) */
	private slingWatchers = new Map<string, ReturnType<typeof setInterval>>();
	/** Pending auto-close timers (agentName -> timer) */
	private autoCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private readonly _onDidTerminalCountChange = new vscode.EventEmitter<number>();
	/** Fired when the number of agent terminals changes (for grid reflow) */
	readonly onDidTerminalCountChange = this._onDidTerminalCountChange.event;

	constructor(
		private readonly client: GtClient,
		private readonly output: vscode.OutputChannel,
		private readonly context?: vscode.ExtensionContext,
	) {}

	private getColorForRig(rig: string): vscode.ThemeColor {
		let color = this.rigColorMap.get(rig);
		if (!color) {
			color = RIG_COLORS[this.colorIndex % RIG_COLORS.length];
			this.colorIndex++;
			this.rigColorMap.set(rig, color);
		}
		return color;
	}

	private getIconForRole(role: string): vscode.ThemeIcon {
		switch (role.toLowerCase()) {
			case 'mayor':
				return new vscode.ThemeIcon('account');
			case 'deacon':
				return new vscode.ThemeIcon('shield');
			case 'witness':
			case 'refinery':
			case 'dog':
				return new vscode.ThemeIcon('tools');
			case 'polecat':
				return new vscode.ThemeIcon('server-process');
			case 'crew':
				return new vscode.ThemeIcon('person');
			default:
				return new vscode.ThemeIcon('terminal');
		}
	}

	private getIconForStatus(role: string, status: AgentDisplayStatus): vscode.ThemeIcon {
		switch (status) {
			case 'completing':
				return new vscode.ThemeIcon('check');
			case 'dead':
			case 'exited':
				return new vscode.ThemeIcon('circle-slash');
			case 'stuck':
				return new vscode.ThemeIcon('warning');
			default:
				return this.getIconForRole(role);
		}
	}

	openAgentTerminal(agent: GtAgent, viewColumn?: vscode.ViewColumn, preserveFocus = false): vscode.Terminal {
		const existing = this.agentTerminals.get(agent.name);
		if (existing) {
			existing.show();
			// Focus the existing battlestation pane
			const state = this.terminalStates.get(agent.name);
			if (state?.paneId !== undefined) {
				vscode.commands.executeCommand('battlestation.focusPane', state.paneId);
			}
			return existing;
		}

		const terminalName = agent.beadId
			? `${agent.name} [${agent.beadId}]`
			: agent.name;

		const terminal = vscode.window.createTerminal({
			name: terminalName,
			cwd: this.client.getWorkspacePath(),
			iconPath: this.getIconForRole(agent.role),
			color: this.getColorForRig(agent.rig),
			env: this.client.getClaudeEnv(),
			location: viewColumn !== undefined
				? { viewColumn }
				: vscode.TerminalLocation.Editor,
		});

		if (agent.session) {
			terminal.sendText(`tmux attach-session -t ${agent.session}`);
		}

		this.agentTerminals.set(agent.name, terminal);
		const slot = this.terminalStates.size;
		const termState: AgentTerminalState = {
			agent,
			terminal,
			status: agent.displayStatus,
			slot,
		};
		this.terminalStates.set(agent.name, termState);
		this.previousAgentStatus.set(agent.name, agent.displayStatus);

		// Register a battlestation pane for this terminal
		vscode.commands.executeCommand('battlestation.addPane', {
			label: terminalName,
			group: agent.rig || '',
		}).then((paneId: unknown) => {
			if (typeof paneId === 'number') {
				termState.paneId = paneId;
			}
		});

		vscode.window.onDidCloseTerminal((closed) => {
			if (closed === terminal) {
				// Guard: skip cleanup if this terminal was replaced (e.g., by markTerminalDone)
				if (this.agentTerminals.get(agent.name) !== terminal) {
					return;
				}
				// Remove the battlestation pane
				const closingState = this.terminalStates.get(agent.name);
				if (closingState?.paneId !== undefined) {
					vscode.commands.executeCommand('battlestation.removePane', closingState.paneId);
				}
				this.agentTerminals.delete(agent.name);
				this.terminalStates.delete(agent.name);
				this.previousAgentStatus.delete(agent.name);
				this.reflowGrid();
				this._onDidTerminalCountChange.fire(this.terminalStates.size);
				this.persistLayout();
			}
		});

		this._onDidTerminalCountChange.fire(this.terminalStates.size);
		this.persistLayout();
		terminal.show(preserveFocus);
		return terminal;
	}

	// --- Feature 1: Auto-add polecat terminals on sling ---

	/**
	 * Watch for a newly slung agent to appear and auto-open its terminal.
	 * Called after a successful `gt sling` command. Polls for the new agent
	 * since sling is asynchronous (daemon spawns the polecat).
	 */
	watchForSlung(beadId: string, rigName: string): void {
		// Cancel any existing watcher for this bead
		const existing = this.slingWatchers.get(beadId);
		if (existing) {
			clearInterval(existing);
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] watchForSlung: watching for agent on bead ${beadId} in ${rigName}`,
		);

		let attempts = 0;
		const maxAttempts = 24; // ~2 minutes at 5-second intervals

		const timer = setInterval(async () => {
			attempts++;

			if (attempts > maxAttempts) {
				this.output.appendLine(
					`  watchForSlung: gave up waiting for agent on bead ${beadId} after ${maxAttempts} attempts`,
				);
				clearInterval(timer);
				this.slingWatchers.delete(beadId);
				return;
			}

			try {
				const agents = await this.client.getAgents();
				const newAgent = agents.find(
					(a) =>
						a.beadId === beadId &&
						a.running &&
						!this.agentTerminals.has(a.name),
				);

				if (newAgent) {
					this.output.appendLine(
						`  watchForSlung: found agent ${newAgent.name} for bead ${beadId}, opening terminal`,
					);
					clearInterval(timer);
					this.slingWatchers.delete(beadId);
					this.openAgentTerminal(newAgent);
				}
			} catch {
				// Transient CLI error, keep polling
			}
		}, 5000);

		this.slingWatchers.set(beadId, timer);
	}

	// --- Feature 2: Mark terminals done on agent completion ---

	/**
	 * Update terminal state when an agent transitions to a completion status.
	 * Recreates the terminal with an updated icon to reflect the new state.
	 */
	private markTerminalDone(agent: GtAgent): void {
		const state = this.terminalStates.get(agent.name);
		if (!state) {
			return;
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] markTerminalDone: ${agent.name} -> ${agent.displayStatus}`,
		);

		state.status = agent.displayStatus;
		state.agent = agent;

		// Dispose old terminal and create a new one with the completion icon.
		// VSCode doesn't support changing terminal icons after creation.
		const oldTerminal = state.terminal;
		const wasVisible = vscode.window.activeTerminal === oldTerminal;

		const suffix =
			agent.displayStatus === 'completing'
				? ' [done]'
				: agent.displayStatus === 'exited'
					? ' [exited]'
					: agent.displayStatus === 'stuck'
						? ' [stuck]'
						: agent.displayStatus === 'dead'
							? ' [dead]'
							: '';

		const baseName = agent.beadId
			? `${agent.name} [${agent.beadId}]`
			: agent.name;

		const newTerminal = vscode.window.createTerminal({
			name: `${baseName}${suffix}`,
			cwd: this.client.getWorkspacePath(),
			iconPath: this.getIconForStatus(agent.role, agent.displayStatus),
			color: this.getColorForRig(agent.rig),
			env: this.client.getClaudeEnv(),
			location: vscode.TerminalLocation.Editor,
		});

		// Re-attach to tmux if the session is still alive
		if (agent.session && (agent.displayStatus === 'completing' || agent.running)) {
			newTerminal.sendText(`tmux attach-session -t ${agent.session}`);
		}

		this.agentTerminals.set(agent.name, newTerminal);
		state.terminal = newTerminal;
		// paneId is preserved from the original state

		vscode.window.onDidCloseTerminal((closed) => {
			if (closed === newTerminal) {
				// Guard: skip cleanup if this terminal was replaced by a subsequent markTerminalDone
				if (this.agentTerminals.get(agent.name) !== newTerminal) {
					return;
				}
				const closingState = this.terminalStates.get(agent.name);
				if (closingState?.paneId !== undefined) {
					vscode.commands.executeCommand('battlestation.removePane', closingState.paneId);
				}
				this.agentTerminals.delete(agent.name);
				this.terminalStates.delete(agent.name);
				this.previousAgentStatus.delete(agent.name);
				this.reflowGrid();
				this._onDidTerminalCountChange.fire(this.terminalStates.size);
				this.persistLayout();
			}
		});

		// Dispose old terminal after creating new one
		oldTerminal.dispose();

		if (wasVisible) {
			newTerminal.show();
		}
	}

	// --- Feature 3: Reconnect tmux ---

	/**
	 * Reconnect an agent's terminal to its tmux session. Used when the
	 * terminal was closed but the agent is still running with an active
	 * tmux session.
	 */
	reconnectAgent(agent: GtAgent): vscode.Terminal | undefined {
		if (!agent.session) {
			this.output.appendLine(
				`[${new Date().toISOString()}] reconnectAgent: ${agent.name} has no tmux session`,
			);
			return undefined;
		}

		// Close stale terminal if it exists
		const stale = this.agentTerminals.get(agent.name);
		if (stale) {
			stale.dispose();
			this.agentTerminals.delete(agent.name);
			this.terminalStates.delete(agent.name);
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] reconnectAgent: reconnecting ${agent.name} to tmux session ${agent.session}`,
		);

		return this.openAgentTerminal(agent);
	}

	// --- Feature 4: Grid reflow on close ---

	/**
	 * Reassign grid slot indices after a terminal is removed.
	 * Compacts the slots so remaining terminals fill the grid
	 * without gaps.
	 */
	private reflowGrid(): void {
		const states = Array.from(this.terminalStates.values())
			.sort((a, b) => a.slot - b.slot);

		for (let i = 0; i < states.length; i++) {
			states[i].slot = i;
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] reflowGrid: ${states.length} terminals, slots reassigned`,
		);
	}

	/**
	 * Get the current terminal grid layout for external consumers
	 * (e.g., BattlestationManager integration).
	 */
	getGridLayout(): { agentName: string; slot: number; status: AgentDisplayStatus }[] {
		return Array.from(this.terminalStates.entries())
			.map(([name, state]) => ({
				agentName: name,
				slot: state.slot,
				status: state.status,
			}))
			.sort((a, b) => a.slot - b.slot);
	}

	getBattlestationState(): import('./views/battlestationView').BattlestationPaneInfo[] {
		const activeTerminal = vscode.window.activeTerminal;
		return Array.from(this.terminalStates.entries())
			.map(([name, state]) => ({
				agentName: name,
				label: state.terminal.name,
				group: state.agent.rig || '',
				slot: state.slot,
				status: state.status,
				paneId: state.paneId,
				focused: state.terminal === activeTerminal,
				role: state.agent.role || '',
				rig: state.agent.rig || '',
				beadId: state.agent.beadId,
				running: state.agent.running,
			}))
			.sort((a, b) => a.slot - b.slot);
	}

	/**
	 * Capture tmux pane content for all agent terminals with active sessions.
	 * Returns a map of agentName -> terminal output text.
	 */
	async captureTmuxOutputs(lines = 200): Promise<Map<string, string>> {
		const outputs = new Map<string, string>();
		const entries = Array.from(this.terminalStates.entries())
			.filter(([_, state]) => state.agent.session);

		const captures = entries.map(async ([name, state]) => {
			try {
				const result = await new Promise<string>((resolve, reject) => {
					execFile('tmux', [
						'capture-pane', '-p', '-S', `-${lines}`, '-t', state.agent.session!,
					], { encoding: 'utf-8', timeout: 5000 }, (err: Error | null, stdout: string) => {
						if (err) {
							reject(err);
						} else {
							resolve(stdout);
						}
					});
				});
				outputs.set(name, result);
			} catch {
				// Session may not exist or tmux not running
			}
		});

		await Promise.allSettled(captures);
		return outputs;
	}

	/**
	 * Get convoy progress for agents by matching their bead IDs to convoy beads.
	 * Returns a map of beadId -> ConvoyProgressInfo.
	 */
	async getConvoyProgressMap(): Promise<Map<string, import('./views/battlestationView').ConvoyProgressInfo>> {
		const map = new Map<string, import('./views/battlestationView').ConvoyProgressInfo>();
		try {
			const convoys = await this.client.getConvoys();
			for (const convoy of convoys) {
				const progress = {
					convoyId: convoy.id,
					convoyTitle: convoy.title,
					completed: convoy.progress.completed,
					total: convoy.progress.total,
				};
				for (const bead of convoy.tracked) {
					map.set(bead.id, progress);
				}
			}
		} catch {
			// Convoy data is best-effort
		}
		return map;
	}

	/**
	 * Get the battlestation pane ID for a given agent.
	 */
	getPaneId(agentName: string): number | undefined {
		return this.terminalStates.get(agentName)?.paneId;
	}

	// --- Enhanced sync with lifecycle detection ---

	/**
	 * Sync agent terminals with current agent state.
	 *
	 * - Detects status transitions and updates terminal state
	 * - Cleans up terminals for agents that no longer exist
	 *
	 * Note: Terminals are NOT auto-opened. Users attach on-demand
	 * by clicking an agent in the tree view.
	 */
	async syncAgentTerminals(): Promise<void> {
		const agents = await this.client.getAgents();
		const currentAgentNames = new Set<string>();

		for (const agent of agents) {
			if (INFRASTRUCTURE_ROLES.has(agent.role)) {
				continue;
			}

			currentAgentNames.add(agent.name);
			const prevStatus = this.previousAgentStatus.get(agent.name);

			if (
				prevStatus !== undefined &&
				prevStatus !== agent.displayStatus &&
				this.agentTerminals.has(agent.name)
			) {
				// Status transition detected
				const isCompletion =
					agent.displayStatus === 'completing' ||
					agent.displayStatus === 'exited' ||
					agent.displayStatus === 'dead' ||
					agent.displayStatus === 'stuck';

				if (isCompletion && prevStatus === 'running') {
					this.markTerminalDone(agent);
					this.scheduleAutoClose(agent.name);
				}
			}

			// Update status snapshot
			this.previousAgentStatus.set(agent.name, agent.displayStatus);

			// Update agent reference in terminal state
			const state = this.terminalStates.get(agent.name);
			if (state) {
				state.agent = agent;
				state.status = agent.displayStatus;
			}
		}

		// Clean up terminals for agents that no longer exist
		for (const name of Array.from(this.previousAgentStatus.keys())) {
			if (!currentAgentNames.has(name) && name !== '__mayor__') {
				this.previousAgentStatus.delete(name);
				if (this.agentTerminals.has(name)) {
					this.scheduleAutoClose(name);
				}
			}
		}
	}

	// --- Feature 5: Auto-close completed terminals ---

	/**
	 * Schedule auto-close for a completed agent terminal.
	 * Waits for the configured delay, then closes — unless the terminal
	 * is currently the active terminal, in which case it defers.
	 */
	private scheduleAutoClose(agentName: string): void {
		// Don't double-schedule
		if (this.autoCloseTimers.has(agentName)) {
			return;
		}

		const delayMs = vscode.workspace.getConfiguration('citadel')
			.get<number>('battlestation.autoCloseDelay', 30000);

		if (delayMs <= 0) {
			return; // Auto-close disabled
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] scheduleAutoClose: ${agentName} in ${delayMs}ms`,
		);

		const timer = setTimeout(() => {
			this.autoCloseTimers.delete(agentName);
			this.tryAutoClose(agentName);
		}, delayMs);

		this.autoCloseTimers.set(agentName, timer);
	}

	/**
	 * Attempt to close a completed terminal. If it's currently active,
	 * defer by re-scheduling a shorter retry.
	 */
	private tryAutoClose(agentName: string): void {
		const terminal = this.agentTerminals.get(agentName);
		if (!terminal) {
			return; // Already closed
		}

		if (vscode.window.activeTerminal === terminal) {
			this.output.appendLine(
				`[${new Date().toISOString()}] tryAutoClose: ${agentName} is active, deferring`,
			);
			// Retry in 10 seconds
			const retry = setTimeout(() => {
				this.autoCloseTimers.delete(agentName);
				this.tryAutoClose(agentName);
			}, 10000);
			this.autoCloseTimers.set(agentName, retry);
			return;
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] tryAutoClose: closing ${agentName}`,
		);
		this.closeAgentTerminal(agentName);
	}

	// --- Existing methods (unchanged) ---

	async openMayorTerminal(): Promise<vscode.Terminal | undefined> {
		const existing = this.agentTerminals.get('__mayor__');
		if (existing) {
			existing.show();
			return existing;
		}

		const gtPath = this.client.getGtPath();
		const claudeEnv = this.client.getClaudeEnv();

		this.output.appendLine(`[${new Date().toISOString()}] openMayorTerminal`);
		this.output.appendLine(`  claudeEnv: ${JSON.stringify(claudeEnv)}`);
		this.output.appendLine(`  gtPath: ${gtPath}`);

		const repaired = await this.preflight();
		if (repaired === undefined) {
			return undefined;
		}

		const envResult = await this.client.syncClaudeWrapper();
		this.output.appendLine(`  tmux env sync: ${envResult ?? '(no provider env vars)'}`);

		const terminal = vscode.window.createTerminal({
			name: '🎩 Mayor',
			cwd: this.client.getWorkspacePath(),
			iconPath: new vscode.ThemeIcon('account'),
			color: new vscode.ThemeColor('terminal.ansiYellow'),
			env: claudeEnv,
			location: vscode.TerminalLocation.Editor,
		});

		terminal.sendText(
			`${gtPath} mayor restart; ` +
			`while ${gtPath} mayor status >/dev/null 2>&1; do ` +
			`${gtPath} mayor attach; sleep 1; ` +
			`done`,
		);

		this.agentTerminals.set('__mayor__', terminal);

		vscode.window.onDidCloseTerminal((closed) => {
			if (closed === terminal) {
				this.agentTerminals.delete('__mayor__');
			}
		});

		terminal.show();
		return terminal;
	}

	private async preflight(): Promise<string[] | undefined> {
		const health = await this.client.getDaemonHealth();
		const issues = this.client.getDaemonIssues(health);

		if (issues.length === 0) {
			this.output.appendLine('  preflight: daemon healthy');
			return [];
		}

		const descriptions = issues.map(issueLabel);
		this.output.appendLine(`  preflight: ${issues.length} issue(s) detected`);
		for (const d of descriptions) {
			this.output.appendLine(`    - ${d}`);
		}

		const choice = await vscode.window.showWarningMessage(
			`Daemon health check found ${issues.length} issue(s):\n${descriptions.map(d => `• ${d}`).join('\n')}`,
			{ modal: true },
			'Repair & Continue',
			'Continue Anyway',
		);

		if (!choice) {
			return undefined;
		}

		if (choice === 'Continue Anyway') {
			return [];
		}

		const fixes = await this.client.repairDaemon();
		for (const fix of fixes) {
			this.output.appendLine(`  repaired: ${fix}`);
		}
		vscode.window.showInformationMessage(`Daemon repaired: ${fixes.join('; ')}`);
		return fixes;
	}

	async showMayorTerminal(): Promise<void> {
		const existing = this.agentTerminals.get('__mayor__');
		if (existing) {
			existing.show();
			return;
		}

		const status = await this.client.getMayorStatus();
		if (status.attached) {
			await this.openMayorTerminal();
		} else {
			vscode.window.showInformationMessage('Mayor is not running. Use "Attach Mayor" to start it.');
		}
	}

	closeAgentTerminal(agentName: string): void {
		const state = this.terminalStates.get(agentName);
		if (state?.paneId !== undefined) {
			vscode.commands.executeCommand('battlestation.removePane', state.paneId);
		}
		const terminal = this.agentTerminals.get(agentName);
		if (terminal) {
			terminal.dispose();
			this.agentTerminals.delete(agentName);
			this.terminalStates.delete(agentName);
			this.previousAgentStatus.delete(agentName);
			this.reflowGrid();
			this._onDidTerminalCountChange.fire(this.terminalStates.size);
			this.persistLayout();
		}
	}

	hasTerminal(agentName: string): boolean {
		return this.agentTerminals.has(agentName);
	}

	showAgentTerminal(agentName: string): boolean {
		const terminal = this.agentTerminals.get(agentName);
		if (terminal) {
			terminal.show();
			return true;
		}
		return false;
	}

	/**
	 * Open terminals for all running worker agents that don't already have one.
	 * Returns the number of new terminals opened.
	 */
	async openAllAgentTerminals(): Promise<number> {
		const agents = await this.client.getAgents();
		const toOpen: GtAgent[] = [];

		for (const agent of agents) {
			if (INFRASTRUCTURE_ROLES.has(agent.role)) {
				continue;
			}
			if (!agent.running) {
				continue;
			}
			if (this.agentTerminals.has(agent.name)) {
				continue;
			}
			toOpen.push(agent);
		}

		if (toOpen.length === 0) {
			this.output.appendLine(
				`[${new Date().toISOString()}] openAllAgentTerminals: no new terminals to open`,
			);
			return 0;
		}

		const totalCount = this.terminalStates.size + toOpen.length;
		await this.setEditorGridLayout(totalCount);

		for (const agent of toOpen) {
			const slot = this.terminalStates.size;
			const viewColumn = this.slotToViewColumn(slot);
			this.openAgentTerminal(agent, viewColumn, true);
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] openAllAgentTerminals: opened ${toOpen.length} new terminals in grid`,
		);

		return toOpen.length;
	}

	/**
	 * Show the battlestation grid overview. If no agent terminals are open,
	 * opens terminals for all running worker agents first.
	 */
	async showBattlestation(): Promise<void> {
		if (this.terminalStates.size === 0) {
			await this.openAllAgentTerminals();
		}

		if (this.terminalStates.size > 0) {
			await this.setEditorGridLayout(this.terminalStates.size);
		} else {
			vscode.window.showInformationMessage('No running agents to display in the battlestation.');
		}
	}

	/** Get the number of active agent terminals (excluding mayor). */
	get terminalCount(): number {
		return this.terminalStates.size;
	}

	// --- Layout persistence ---

	/**
	 * Save current terminal layout to workspaceState for restoration
	 * after a restart. Called whenever terminals are added/removed.
	 */
	private persistLayout(): void {
		if (!this.context) {
			return;
		}

		const entries: PersistedPaneEntry[] = [];
		for (const [name, state] of this.terminalStates) {
			entries.push({
				agentName: name,
				rig: state.agent.rig,
				role: state.agent.role,
				session: state.agent.session,
				beadId: state.agent.beadId,
				slot: state.slot,
			});
		}

		this.context.workspaceState.update(LAYOUT_STORAGE_KEY, entries);
		this.output.appendLine(
			`[${new Date().toISOString()}] persistLayout: saved ${entries.length} pane(s)`,
		);
	}

	/**
	 * Restore terminal layout from a previous session. Queries the current
	 * agents list, matches against the persisted layout, and reconnects
	 * tmux sessions for agents that are still running.
	 */
	async restoreLayout(): Promise<number> {
		if (!this.context) {
			return 0;
		}

		const saved = this.context.workspaceState.get<PersistedPaneEntry[]>(LAYOUT_STORAGE_KEY);
		if (!saved || saved.length === 0) {
			this.output.appendLine(
				`[${new Date().toISOString()}] restoreLayout: no saved layout found`,
			);
			return 0;
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] restoreLayout: found ${saved.length} saved pane(s), querying agents…`,
		);

		let agents: GtAgent[];
		try {
			agents = await this.client.getAgents();
		} catch {
			this.output.appendLine(
				`  restoreLayout: failed to query agents, skipping restore`,
			);
			return 0;
		}

		const agentsByName = new Map<string, GtAgent>();
		for (const a of agents) {
			agentsByName.set(a.name, a);
		}

		// Sort by saved slot to preserve ordering
		const sorted = [...saved].sort((a, b) => a.slot - b.slot);
		let restored = 0;

		for (const entry of sorted) {
			// Skip if terminal already open
			if (this.agentTerminals.has(entry.agentName)) {
				continue;
			}

			const liveAgent = agentsByName.get(entry.agentName);

			if (liveAgent && liveAgent.running) {
				// Agent is still running — open terminal and reconnect tmux
				this.output.appendLine(
					`  restoreLayout: reconnecting ${entry.agentName} (session: ${liveAgent.session ?? 'none'})`,
				);
				this.openAgentTerminal(liveAgent);
				restored++;
			} else if (liveAgent && liveAgent.session) {
				// Agent not running but has a tmux session — reconnect for inspection
				this.output.appendLine(
					`  restoreLayout: reconnecting non-running ${entry.agentName} (session: ${liveAgent.session})`,
				);
				this.openAgentTerminal(liveAgent);
				restored++;
			}
			// If agent is gone entirely, skip — don't create orphan terminals
		}

		this.output.appendLine(
			`[${new Date().toISOString()}] restoreLayout: restored ${restored}/${saved.length} terminal(s)`,
		);

		// Clear stale entries that couldn't be restored
		if (restored > 0) {
			this.persistLayout();
		} else {
			// All entries were stale, clear the saved layout
			this.context.workspaceState.update(LAYOUT_STORAGE_KEY, undefined);
		}

		return restored;
	}

	/**
	 * Set the editor area grid layout based on the terminal count.
	 * Arranges editor groups so terminals display in a responsive grid.
	 */
	async setEditorGridLayout(count: number): Promise<void> {
		if (count <= 0) {
			return;
		}
		const layout = this.computeGridLayout(count);
		await vscode.commands.executeCommand('vscode.setEditorLayout', layout);
	}

	/**
	 * Compute the optimal grid layout for the given number of terminals.
	 * Returns a layout descriptor compatible with vscode.setEditorLayout.
	 */
	private computeGridLayout(count: number): { orientation: number; groups: object[] } {
		if (count <= 1) {
			return { orientation: 0, groups: [{}] };
		}
		if (count <= 3) {
			const groups = Array.from({ length: count }, () => ({}));
			return { orientation: 0, groups };
		}

		// Grid: compute rows and columns
		const cols = Math.min(Math.ceil(Math.sqrt(count)), 3);
		const rows = Math.ceil(count / cols);

		const rowGroups: object[] = [];
		for (let r = 0; r < rows; r++) {
			const colCount = Math.min(cols, count - r * cols);
			const colGroups = Array.from({ length: colCount }, () => ({}));
			rowGroups.push({ groups: colGroups, size: 1 / rows });
		}

		return { orientation: 1, groups: rowGroups };
	}

	/**
	 * Map a grid slot index to a VS Code ViewColumn for editor placement.
	 */
	private slotToViewColumn(slot: number): vscode.ViewColumn {
		return Math.min(slot + 1, 9) as vscode.ViewColumn;
	}

	dispose(): void {
		// Persist layout before teardown so it can be restored on restart
		this.persistLayout();
		for (const timer of this.slingWatchers.values()) {
			clearInterval(timer);
		}
		this.slingWatchers.clear();
		for (const timer of this.autoCloseTimers.values()) {
			clearTimeout(timer);
		}
		this.autoCloseTimers.clear();
		this.agentTerminals.clear();
		this.terminalStates.clear();
		this.previousAgentStatus.clear();
		this._onDidTerminalCountChange.dispose();
	}
}
