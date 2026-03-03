/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { GtClient } from './gtClient';
import { AgentsTreeProvider } from './views/agentsView';
import { BeadsTreeProvider } from './views/beadsView';
import { ConvoysTreeProvider } from './views/convoysView';
import { RigsTreeProvider } from './views/rigsView';
import { MayorTreeProvider } from './views/mayorView';
import { MailTreeProvider } from './views/mailView';
import { QueueTreeProvider } from './views/queueView';
import { HealthTreeProvider } from './views/healthView';
import { SummaryTreeProvider } from './views/summaryView';
import { ActivityTreeProvider } from './views/activityView';
import { CitadelStatusBar } from './statusBar';
import { TerminalManager } from './terminalManager';
import { slingBead } from './commands/sling';
import { createBead, showBeadDetails, deleteBead } from './commands/bead';
import { createConvoy, showConvoyDetails } from './commands/convoy';
import { detachMayor } from './commands/mayor';
import { showMailMessage, composeMail } from './commands/mail';
import { EscalationsTreeProvider } from './views/escalationsView';
import { resolveEscalation } from './commands/escalation';

export function activate(context: vscode.ExtensionContext): void {
	console.log('[Citadel] Extension activating in extension host (pid ' + process.pid + ')');
	const outputChannel = vscode.window.createOutputChannel('Citadel');
	const client = new GtClient();
	const terminalManager = new TerminalManager(client, outputChannel, context);
	const statusBar = new CitadelStatusBar(client);

	// --- Tree data providers ---
	const summaryProvider = new SummaryTreeProvider(client);
	const agentsProvider = new AgentsTreeProvider(client);
	const beadsProvider = new BeadsTreeProvider(client);
	const convoysProvider = new ConvoysTreeProvider(client);
	const rigsProvider = new RigsTreeProvider(client);
	const mayorProvider = new MayorTreeProvider(client);
	const mailProvider = new MailTreeProvider(client);
	const queueProvider = new QueueTreeProvider(client);
	const healthProvider = new HealthTreeProvider(client);
	const activityProvider = new ActivityTreeProvider(client);
	const escalationsProvider = new EscalationsTreeProvider(client);

	// Summary: at-a-glance stats and alerts
	const summaryTreeView = vscode.window.createTreeView('citadel.summary', {
		treeDataProvider: summaryProvider,
	});
	summaryProvider.onHasAlertsChanged = (hasAlerts) => {
		summaryTreeView.badge = hasAlerts
			? { value: 1, tooltip: 'Alerts need attention' }
			: undefined;
	};

	// Agents: hero view with running-count badge
	const agentsTreeView = vscode.window.createTreeView('citadel.agents', {
		treeDataProvider: agentsProvider,
	});
	agentsProvider.onRunningCountChanged = (count) => {
		agentsTreeView.badge = count > 0
			? { value: count, tooltip: `${count} running agent${count === 1 ? '' : 's'}` }
			: undefined;
	};

	const beadsTreeView = vscode.window.createTreeView('citadel.beads', {
		treeDataProvider: beadsProvider,
	});
	// Restore persisted beads filter mode
	const savedFilterMode = context.workspaceState.get<'active' | 'all'>('citadel.beadsFilterMode', 'active');
	beadsProvider.setFilterMode(savedFilterMode);
	vscode.commands.executeCommand('setContext', 'citadel.beadsFilterMode', savedFilterMode);
	const convoysTreeView = vscode.window.createTreeView('citadel.convoys', {
		treeDataProvider: convoysProvider,
	});
	vscode.window.registerTreeDataProvider('citadel.rigs', rigsProvider);
	const mayorTreeView = vscode.window.createTreeView('citadel.mayor', {
		treeDataProvider: mayorProvider,
	});
	const mailTreeView = vscode.window.createTreeView('citadel.mail', {
		treeDataProvider: mailProvider,
	});
	mailProvider.onUnreadCountChanged = (count) => {
		mailTreeView.badge = count > 0
			? { value: count, tooltip: `${count} unread message${count === 1 ? '' : 's'}` }
			: undefined;
	};
	const queueTreeView = vscode.window.createTreeView('citadel.queue', {
		treeDataProvider: queueProvider,
	});
	const healthTreeView = vscode.window.createTreeView('citadel.health', {
		treeDataProvider: healthProvider,
	});
	const activityTreeView = vscode.window.createTreeView('citadel.activity', {
		treeDataProvider: activityProvider,
	});
	const escalationsTreeView = vscode.window.createTreeView('citadel.escalations', {
		treeDataProvider: escalationsProvider,
	});

	// --- Commands: existing ---
	context.subscriptions.push(
		vscode.commands.registerCommand('citadel.refreshSummary', () => {
			summaryProvider.refresh();
		}),
		vscode.commands.registerCommand('citadel.refreshAgents', () => {
			agentsProvider.refresh();
			statusBar.refresh();
		}),
		vscode.commands.registerCommand('citadel.refreshBeads', () => {
			beadsProvider.refresh();
		}),
		vscode.commands.registerCommand('citadel.filterBeads', () => {
			const next = beadsProvider.filterMode === 'active' ? 'all' : 'active';
			beadsProvider.setFilterMode(next);
			context.workspaceState.update('citadel.beadsFilterMode', next);
		}),
		vscode.commands.registerCommand('citadel.createBead', async () => {
			await createBead(client);
			beadsProvider.refresh();
		}),
		vscode.commands.registerCommand('citadel.showBead', (item?: { bead?: { id?: string } }) => showBeadDetails(client, item?.bead?.id)),
		vscode.commands.registerCommand('citadel.deleteBead', async (item?: { bead?: { id?: string } }) => {
			await deleteBead(client, item?.bead?.id);
			beadsProvider.refresh();
		}),
		vscode.commands.registerCommand('citadel.refreshConvoys', () => {
			convoysProvider.refresh();
			statusBar.refresh();
		}),
		vscode.commands.registerCommand('citadel.refreshRigs', () => {
			rigsProvider.refresh();
		}),
		vscode.commands.registerCommand('citadel.slingBead', async (item?: { bead?: { id?: string } }) => {
			const result = await slingBead(client, item?.bead?.id);
			// Auto-watch for the new agent terminal after sling
			if (result) {
				terminalManager.watchForSlung(result.beadId, result.rigName);
			}
		}),
		vscode.commands.registerCommand('citadel.createConvoy', () => createConvoy(client)),
		vscode.commands.registerCommand('citadel.convoyShow', (convoyId?: string) => showConvoyDetails(client, convoyId)),
		vscode.commands.registerCommand('citadel.attachMayor', async () => {
			await terminalManager.openMayorTerminal();
			mayorProvider.updateStatus({ running: true, attached: true });
			statusBar.setMayorAttached(true);
		}),
		vscode.commands.registerCommand('citadel.detachMayor', async () => {
			await detachMayor(client);
			terminalManager.closeAgentTerminal('__mayor__');
			mayorProvider.updateStatus({ running: true, attached: false });
			statusBar.setMayorAttached(false);
		}),
		vscode.commands.registerCommand('citadel.showMayorTerminal', () => {
			terminalManager.showMayorTerminal();
		}),
		vscode.commands.registerCommand('citadel.addRig', async () => {
			const name = await vscode.window.showInputBox({ prompt: 'Rig name', placeHolder: 'myproject' });
			if (!name) { return; }
			const repoUrl = await vscode.window.showInputBox({ prompt: 'Repository URL', placeHolder: 'https://github.com/you/repo.git' });
			if (!repoUrl) { return; }
			try {
				await client.addRig(name, repoUrl);
				vscode.window.showInformationMessage(`Added rig "${name}"`);
				rigsProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to add rig: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.openAgentTerminal', (item: { agent?: import('./gtClient').GtAgent }) => {
			if (item?.agent) {
				if (item.agent.role === 'mayor') {
					terminalManager.showMayorTerminal();
				} else {
					terminalManager.openAgentTerminal(item.agent);
				}
			}
		}),
		vscode.commands.registerCommand('citadel.reconnectTerminal', async (item?: { agent?: import('./gtClient').GtAgent }) => {
			const agent = item?.agent;
			if (agent) {
				terminalManager.reconnectAgent(agent);
				return;
			}
			// If no agent provided, pick from running agents that have tmux sessions
			const agents = await client.getAgents();
			const reconnectable = agents.filter(a => a.running && a.session);
			if (reconnectable.length === 0) {
				vscode.window.showInformationMessage('No agents with active tmux sessions to reconnect.');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				reconnectable.map(a => ({
					label: a.name,
					description: `${a.displayStatus} — ${a.rig} (session: ${a.session})`,
					agent: a,
				})),
				{ placeHolder: 'Select agent to reconnect tmux session' },
			);
			if (picked) {
				terminalManager.reconnectAgent(picked.agent);
			}
		}),
		vscode.commands.registerCommand('citadel.spawnAgent', async () => {
			const rigs = await client.getRigs();
			if (rigs.length === 0) {
				vscode.window.showWarningMessage('No rigs configured. Add a rig first.');
				return;
			}
			const rigName = rigs.length === 1
				? rigs[0].name
				: await vscode.window.showQuickPick(rigs.map(r => r.name), { placeHolder: 'Select rig' });
			if (!rigName) { return; }

			const beadId = await vscode.window.showInputBox({
				prompt: 'Bead ID to assign',
				placeHolder: 'gt-abc12',
			});
			if (!beadId) { return; }

			try {
				await client.slingBead(beadId, rigName);
				vscode.window.showInformationMessage(`Spawned agent for ${beadId} on ${rigName}`);
				agentsProvider.refresh();
				terminalManager.watchForSlung(beadId.trim(), rigName);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to spawn agent: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.killAgent', async (item: { agent?: import('./gtClient').GtAgent }) => {
			const agentName: string | undefined = item?.agent?.name;
			const agentRole: string | undefined = item?.agent?.role;
			const agentRig: string | undefined = item?.agent?.rig;
			if (!agentName) {
				const agents = await client.getAgents();
				const killable = agents.filter(a => a.running || a.displayStatus === 'idle');
				if (killable.length === 0) {
					vscode.window.showInformationMessage('No agents to kill');
					return;
				}
				const picked = await vscode.window.showQuickPick(
					killable.map(a => ({ label: a.name, description: `${a.displayStatus} — ${a.rig}`, agent: a })),
					{ placeHolder: 'Select agent to kill' },
				);
				if (!picked) { return; }
				await vscode.commands.executeCommand('citadel.killAgent', { agent: picked.agent });
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`Kill agent "${agentName}"?`, { modal: true }, 'Kill',
			);
			if (confirm !== 'Kill') { return; }

			try {
				await client.killAgent(agentName, agentRole, agentRig);
				terminalManager.closeAgentTerminal(agentName);
				if (agentRole === 'mayor') {
					terminalManager.closeAgentTerminal('__mayor__');
					mayorProvider.updateStatus({ running: false, attached: false });
	statusBar.setMayorAttached(false);
				}
				vscode.window.showInformationMessage(`Killed agent "${agentName}"`);
				agentsProvider.refresh();
				statusBar.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to kill agent: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.restartAgent', async (item: { agent?: import('./gtClient').GtAgent }) => {
			const agent = item?.agent;
			if (!agent) {
				const agents = await client.getAgents();
				const restartable = agents.filter(a =>
					a.role !== 'mayor' && a.role !== 'deacon' && a.running,
				);
				if (restartable.length === 0) {
					vscode.window.showInformationMessage('No restartable agents');
					return;
				}
				const picked = await vscode.window.showQuickPick(
					restartable.map(a => ({ label: a.name, description: `${a.role} — ${a.rig}`, agent: a })),
					{ placeHolder: 'Select agent to restart' },
				);
				if (!picked) { return; }
				await vscode.commands.executeCommand('citadel.restartAgent', { agent: picked.agent });
				return;
			}

			try {
				await client.restartAgent(agent.name, agent.role, agent.rig);
				vscode.window.showInformationMessage(`Restart initiated for "${agent.name}" (${agent.role})`);
				agentsProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to restart agent: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.openDashboard', async () => {
			const config = vscode.workspace.getConfiguration('citadel');
			const port = config.get<number>('dashboardPort', 8080);
			try {
				client.openDashboard(port);
				const url = `http://localhost:${port}`;
				vscode.env.openExternal(vscode.Uri.parse(url));
				vscode.window.showInformationMessage(`Dashboard at ${url}`);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to open dashboard: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.statusBarClick', () => statusBar.showStatusMenu()),
		vscode.commands.registerCommand('citadel.configureClaudeProvider', () => statusBar.configureClaudeProvider()),
		vscode.commands.registerCommand('citadel.repairDaemon', async () => {
			try {
				const health = await client.getDaemonHealth();
				const issues = client.getDaemonIssues(health);

				if (issues.length === 0) {
					vscode.window.showInformationMessage('Daemon is healthy — no issues found.');
					return;
				}

				const fixes = await client.repairDaemon();
				vscode.window.showInformationMessage(`Daemon repaired: ${fixes.join('; ')}`);
				statusBar.refresh();
				agentsProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Daemon repair failed: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.debugAgents', async () => {
			try {
				const dump = await client.debugAgents();
				outputChannel.clear();
				outputChannel.appendLine(dump);
				outputChannel.show(true);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`Debug failed: ${msg}`);
				outputChannel.show(true);
			}
		}),
		vscode.commands.registerCommand('citadel.daemonStatus', async () => {
			try {
				const health = await client.getDaemonHealth();
				const issues = client.getDaemonIssues(health);

				const lines: string[] = [];
				lines.push(health.running ? `Daemon running (PID ${health.pid})` : 'Daemon is NOT running');
				if (health.staleHeartbeat) {
					lines.push(`Heartbeat stale (${health.heartbeatAge} old)`);
				}
				for (const cl of health.crashLoops) {
					lines.push(`${cl.agent}: crash loop (${cl.restartCount} restarts)`);
				}
				if (health.staleAgentConfig) {
					lines.push(`Stale agent config: ${health.staleAgentCommand}`);
				}

				if (issues.length > 0) {
					const action = await vscode.window.showWarningMessage(lines.join('\n'), 'Repair');
					if (action === 'Repair') {
						await vscode.commands.executeCommand('citadel.repairDaemon');
					}
				} else {
					vscode.window.showInformationMessage(lines.join(' | '));
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to check daemon: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.runBootstrap', async () => {
			let scriptPath: string | undefined;

			// Look for the bundled script relative to the extension
			const extPath = context.extensionPath;
			const bundled = path.join(extPath, 'scripts', 'setup-gastown.sh');
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(bundled));
				scriptPath = bundled;
			} catch {
				// not bundled — check workspace folders
			}

			if (!scriptPath) {
				const workspaceFolders = vscode.workspace.workspaceFolders;
				if (workspaceFolders) {
					for (const folder of workspaceFolders) {
						const candidate = vscode.Uri.joinPath(folder.uri, 'scripts', 'setup-gastown.sh');
						try {
							await vscode.workspace.fs.stat(candidate);
							scriptPath = candidate.fsPath;
							break;
						} catch {
							// not found in this folder
						}
					}
				}
			}

			if (!scriptPath) {
				const picked = await vscode.window.showOpenDialog({
					canSelectMany: false,
					filters: { 'Shell Scripts': ['sh'] },
					title: 'Locate setup-gastown.sh',
				});
				if (picked && picked.length > 0) {
					scriptPath = picked[0].fsPath;
				}
			}

			if (!scriptPath) {
				vscode.window.showWarningMessage('Could not find scripts/setup-gastown.sh. The script should be bundled with the extension or in a workspace folder.');
				return;
			}

			const terminal = vscode.window.createTerminal({
				name: '🔧 Gastown Bootstrap',
				iconPath: new vscode.ThemeIcon('wrench'),
				color: new vscode.ThemeColor('terminal.ansiGreen'),
			});

			terminal.sendText(`bash "${scriptPath}"`);
			terminal.show();
			vscode.window.showInformationMessage('Running Gastown bootstrap setup…');
		}),

		// --- Commands: new features ---
		vscode.commands.registerCommand('citadel.refreshMail', () => {
			mailProvider.refresh();
		}),
		vscode.commands.registerCommand('citadel.showMail', (msg?: import('./cli/contracts').GtMailMessage) => showMailMessage(client, msg)),
		vscode.commands.registerCommand('citadel.composeMail', () => composeMail(client)),
		vscode.commands.registerCommand('citadel.refreshQueue', () => queueProvider.refresh()),
		vscode.commands.registerCommand('citadel.retryMergeRequest', async (treeItem?: import('./views/queueView').QueueTreeItem) => {
			const item = treeItem?.item;
			if (!item) { return; }
			try {
				await client.retryMergeRequest(item.rig, item.id);
				vscode.window.showInformationMessage(`Retrying merge request ${item.id}`);
				queueProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to retry MR: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.rejectMergeRequest', async (treeItem?: import('./views/queueView').QueueTreeItem) => {
			const item = treeItem?.item;
			if (!item) { return; }
			const reason = await vscode.window.showInputBox({
				prompt: `Reason for rejecting ${item.id}`,
				placeHolder: 'e.g. Superseded by other work',
			});
			if (!reason) { return; }
			const confirm = await vscode.window.showWarningMessage(
				`Reject merge request "${item.title || item.branch}"?`, { modal: true }, 'Reject',
			);
			if (confirm !== 'Reject') { return; }
			try {
				await client.rejectMergeRequest(item.rig, item.id, reason);
				vscode.window.showInformationMessage(`Rejected merge request ${item.id}`);
				queueProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to reject MR: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.showMergeRequestStatus', async (treeItem?: import('./views/queueView').QueueTreeItem) => {
			const item = treeItem?.item;
			if (!item) { return; }
			try {
				const status = await client.getMergeRequestStatus(item.id);
				const doc = await vscode.workspace.openTextDocument({ content: status, language: 'markdown' });
				await vscode.window.showTextDocument(doc, { preview: true });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to get MR status: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.nudgeRefinery', async () => {
			try {
				await client.nudgeRefinery();
				vscode.window.showInformationMessage('Refinery restarted — processing queue');
				queueProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to nudge refinery: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.openBeadTerminal', async (bead?: import('./gtClient').GtBead) => {
			if (!bead?.assignee) { return; }
			const agents = await client.getAgents();
			const agent = agents.find(a => a.name === bead.assignee || a.beadId === bead.id);
			if (agent) {
				terminalManager.openAgentTerminal(agent);
			} else {
				// Agent not in current list — construct minimal fallback
				terminalManager.openAgentTerminal({
					name: bead.assignee,
					status: bead.status,
					displayStatus: 'idle',
					rig: '',
					role: 'polecat',
					running: false,
					hasWork: false,
					beadId: bead.id,
				});
			}
		}),
		vscode.commands.registerCommand('citadel.showBattlestation', async () => {
			// Open agent terminals in editor area grid layout
			await terminalManager.showBattlestation();
		}),
		vscode.commands.registerCommand('citadel.openAllAgentTerminals', () => terminalManager.openAllAgentTerminals()),
		vscode.commands.registerCommand('citadel.refreshMayor', () => mayorProvider.refreshFromCli()),
		vscode.commands.registerCommand('citadel.refreshActivity', () => activityProvider.refresh()),
		vscode.commands.registerCommand('citadel.filterActivity', () => activityProvider.cycleFilter()),
		vscode.commands.registerCommand('citadel.refreshEscalations', () => escalationsProvider.refresh()),
		vscode.commands.registerCommand('citadel.resolveEscalation', async (escalation?: import('./cli/contracts').GtEscalation) => {
			await resolveEscalation(client, escalation);
			escalationsProvider.refresh();
		}),
		vscode.commands.registerCommand('citadel.openEscalationTerminal', async (escalation?: import('./cli/contracts').GtEscalation) => {
			if (!escalation?.agent) { return; }
			const agents = await client.getAgents();
			const agent = agents.find(a => a.name === escalation.agent);
			if (agent) {
				terminalManager.openAgentTerminal(agent);
			}
		}),
		vscode.commands.registerCommand('citadel.refreshHealth', () => healthProvider.refresh()),
		vscode.commands.registerCommand('citadel.healthRestart', async (item: import('./views/healthView').HealthTierItem) => {
			if (!item?.tier) { return; }
			try {
				switch (item.tier) {
					case 'daemon': await client.restartDaemon(); break;
					case 'dolt': await client.restartDolt(); break;
					case 'deacon': await client.restartDeacon(); break;
					default: return;
				}
				vscode.window.showInformationMessage(`Restarted ${item.label}`);
				healthProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to restart ${item.label}: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.healthStop', async (item: import('./views/healthView').HealthTierItem) => {
			if (!item?.tier) { return; }
			try {
				switch (item.tier) {
					case 'daemon': await client.stopDaemon(); break;
					case 'dolt': await client.stopDolt(); break;
					case 'deacon': await client.stopDeacon(); break;
					default: return;
				}
				vscode.window.showInformationMessage(`Stopped ${item.label}`);
				healthProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to stop ${item.label}: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.healthStart', async (item: import('./views/healthView').HealthTierItem) => {
			if (!item?.tier) { return; }
			try {
				switch (item.tier) {
					case 'daemon': await client.startDaemon(); break;
					case 'dolt': await client.startDolt(); break;
					case 'deacon': await client.startDeacon(); break;
					default: return;
				}
				vscode.window.showInformationMessage(`Started ${item.label}`);
				healthProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to start ${item.label}: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('citadel.healthClearCrashLoops', async (item: import('./views/healthView').HealthTierItem) => {
			if (!item?.tier) { return; }
			try {
				await client.clearCrashLoops();
				vscode.window.showInformationMessage(`Cleared crash loops for ${item.label}`);
				healthProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to clear crash loops: ${msg}`);
			}
		}),
	);

	// --- Cross-panel wiring: terminal count → status bar ---
	context.subscriptions.push(
		terminalManager.onDidTerminalCountChange((count) => {
			statusBar.setTerminalCount(count);
		}),
	);

	// --- Configuration change listener ---
	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('citadel')) {
			client.reload();
			statusBar.refresh();
		}
		if (e.affectsConfiguration('citadel.claude')) {
			statusBar.refreshClaudeItem();
			client.syncClaudeWrapper().catch(err =>
				console.error('[Citadel] failed to sync claude wrapper:', err));
		}
	});

	// --- Auto-refresh (visibility-gated + tiered to reduce CLI calls) ---
	const refreshInterval = vscode.workspace.getConfiguration('citadel').get<number>('refreshInterval', 5000);
	let refreshTick = 0;
	const autoRefresh = setInterval(() => {
		refreshTick++;

		// Every tick: badge-bearing views and always-visible elements
		agentsProvider.refresh();
		statusBar.refresh();
		terminalManager.syncAgentTerminals();

		// Visibility-gated: skip CLI calls for hidden panels
		if (beadsTreeView.visible) { beadsProvider.refresh(); }
		if (convoysTreeView.visible) { convoysProvider.refresh(); }

		// Tiered: less-critical views refresh every other tick (~10s)
		if (refreshTick % 2 === 0) {
			mailProvider.refresh();
			rigsProvider.refresh();
			if (summaryTreeView.visible) { summaryProvider.refresh(); }
			if (mayorTreeView.visible) { mayorProvider.refreshFromCli(); }
			if (queueTreeView.visible) { queueProvider.refresh(); }
			if (activityTreeView.visible) { activityProvider.refresh(); }
			if (escalationsTreeView.visible) { escalationsProvider.refresh(); }
		}

		// Slowest tier: health refreshes every 3rd tick (~15s)
		if (refreshTick % 3 === 0) {
			if (healthTreeView.visible) { healthProvider.refresh(); }
		}
	}, refreshInterval);

	context.subscriptions.push({
		dispose: () => {
			clearInterval(autoRefresh);
			summaryTreeView.dispose();
			agentsTreeView.dispose();
			beadsTreeView.dispose();
			convoysTreeView.dispose();
			mayorTreeView.dispose();
			mailTreeView.dispose();
			queueTreeView.dispose();
			healthTreeView.dispose();
			activityTreeView.dispose();
			escalationsTreeView.dispose();
			statusBar.dispose();
			terminalManager.dispose();
			healthProvider.dispose();
			client.dispose();
		}
	});

	statusBar.start();

	// Force-show the Work panel whenever the Citadel panel becomes visible.
	// This ensures clicking the citadel icon always reveals the secondary sidebar
	// work panel, matching the citadel panel's force-show behavior.
	agentsTreeView.onDidChangeVisibility(e => {
		if (e.visible) {
			vscode.commands.executeCommand('citadel.beads.focus');
		}
	});

	client.syncClaudeWrapper().catch(err =>
		console.error('[Citadel] initial claude wrapper sync failed:', err));

	client.getMayorStatus().then(status => {
		mayorProvider.updateStatus(status);
		if (status.attached) {
			terminalManager.openMayorTerminal();
		}
	});

	// Restore battlestation layout from previous session
	terminalManager.restoreLayout().then(restored => {
		if (restored > 0) {
			outputChannel.appendLine(`[Citadel] Restored ${restored} terminal(s) from previous session`);
			statusBar.setTerminalCount(terminalManager.terminalCount);
		}
	});
}

export function deactivate(): void {}
