/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GtClient } from './gtClient';

type HealthLevel = 'healthy' | 'warning' | 'error';

export class CitadelStatusBar {
	private item: vscode.StatusBarItem;

	private _mayorAttached = false;
	private _agentCount = 0;
	private _agentTotal = 0;
	private _convoyText = '';
	private _claudeProvider = '--';
	private _terminalCount = 0;

	constructor(private readonly client: GtClient) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.item.command = 'citadel.statusBarClick';
	}

	/** Update the terminal count displayed in the status bar. */
	setTerminalCount(count: number): void {
		this._terminalCount = count;
		this.render();
	}

	start(): void {
		this.refreshClaudeItem();
		this.refresh();
		this.item.show();
	}

	setMayorAttached(attached: boolean): void {
		this._mayorAttached = attached;
		this.render();
	}

	async refresh(): Promise<void> {
		try {
			const [convoys, agents, mayorStatus] = await Promise.all([
				this.client.getConvoys(),
				this.client.getWorkerAgents(),
				this.client.getMayorStatus(),
			]);

			const activeAgents = agents.filter(a => a.running);
			this._agentCount = activeAgents.length;
			this._agentTotal = agents.length;

			if (convoys.length > 0) {
				const active = convoys.find(c => c.status === 'active') || convoys[0];
				this._convoyText = `${active.progress.completed}/${active.progress.total}`;
			} else {
				this._convoyText = '';
			}

			this._mayorAttached = mayorStatus.attached;
		} catch (err) {
			console.warn('[Citadel] status bar refresh failed:', err instanceof Error ? err.message : err);
			this._agentCount = 0;
			this._agentTotal = 0;
			this._convoyText = '';
		}

		this.render();
	}

	refreshClaudeItem(): void {
		const provider = vscode.workspace.getConfiguration('citadel.claude').get<string>('provider', 'none');
		const labels: Record<string, string> = {
			none: '--',
			vertex: 'Vertex',
			bedrock: 'Bedrock',
			anthropic: 'Anthropic',
		};
		this._claudeProvider = labels[provider] || provider;
		this.render();
	}

	async configureClaudeProvider(): Promise<void> {
		const config = vscode.workspace.getConfiguration('citadel.claude');
		const current = config.get<string>('provider', 'none');

		const picked = await vscode.window.showQuickPick(
			[
				{ label: 'None', description: 'Do not inject provider env vars', value: 'none' },
				{ label: 'Google Vertex AI', description: 'CLAUDE_CODE_USE_VERTEX + project/region', value: 'vertex' },
				{ label: 'Amazon Bedrock', description: 'CLAUDE_CODE_USE_BEDROCK + region', value: 'bedrock' },
				{ label: 'Anthropic API', description: 'Direct API key', value: 'anthropic' },
			].map(item => ({
				...item,
				picked: item.value === current,
			})),
			{ placeHolder: 'Select Claude API provider', title: 'Claude Provider' },
		);

		if (!picked) {
			return;
		}

		const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
		const target = hasWorkspace
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await config.update('provider', picked.value, target);

		switch (picked.value) {
			case 'vertex':
				await this.promptVertexFields(config, target);
				break;
			case 'bedrock':
				await this.promptBedrockFields(config, target);
				break;
			case 'anthropic':
				await this.promptAnthropicFields(config, target);
				break;
		}

		this.refreshClaudeItem();
	}

	async showStatusMenu(): Promise<void> {
		const items: (vscode.QuickPickItem & { action: string })[] = [
			{
				label: `$(person) Agents: ${this._agentCount}/${this._agentTotal}`,
				description: this._agentCount > 0 ? 'open terminals in battlestation' : 'none active',
				action: 'agents',
			},
		];

		if (this._convoyText) {
			items.push({
				label: `$(tasklist) Convoy: ${this._convoyText}`,
				description: 'open polecat terminals in battlestation',
				action: 'convoy',
			});
		}

		items.push({
			label: `$(account) Mayor: ${this._mayorAttached ? 'ON' : 'OFF'}`,
			description: this._mayorAttached ? 'show mayor terminal' : 'attach mayor',
			action: 'mayor',
		});

		items.push({
			label: `$(layout) Battlestation${this._terminalCount > 0 ? ` (${this._terminalCount})` : ''}`,
			description: this._terminalCount > 0 ? `${this._terminalCount} terminal${this._terminalCount !== 1 ? 's' : ''} open` : 'open terminal grid',
			action: 'battlestation',
		});

		items.push({
			label: `$(cloud) Claude: ${this._claudeProvider}`,
			description: 'API provider',
			action: 'claude',
		});

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Citadel Status',
			title: 'Citadel',
		});

		if (!picked) {
			return;
		}

		switch (picked.action) {
			case 'agents':
				vscode.commands.executeCommand('citadel.showBattlestation');
				break;
			case 'convoy':
				vscode.commands.executeCommand('citadel.showBattlestation');
				break;
			case 'mayor':
				vscode.commands.executeCommand(this._mayorAttached ? 'citadel.showMayorTerminal' : 'citadel.attachMayor');
				break;
			case 'battlestation':
				vscode.commands.executeCommand('citadel.showBattlestation');
				break;
			case 'claude':
				vscode.commands.executeCommand('citadel.configureClaudeProvider');
				break;
		}
	}

	private render(): void {
		const segments: string[] = ['$(flame)'];

		segments.push(`${this._agentCount}/${this._agentTotal}`);

		if (this._convoyText) {
			segments.push(`$(tasklist) ${this._convoyText}`);
		}

		segments.push(`$(account) ${this._mayorAttached ? 'ON' : 'OFF'}`);

		if (this._terminalCount > 0) {
			segments.push(`$(layout) ${this._terminalCount}`);
		}

		this.item.text = segments.join('  ');

		const health = this.computeHealth();
		switch (health) {
			case 'healthy':
				this.item.backgroundColor = undefined;
				this.item.color = new vscode.ThemeColor('testing.runAction');
				break;
			case 'warning':
				this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
				break;
			case 'error':
				this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
				this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
				break;
		}

		const tooltipLines = [
			`Agents: ${this._agentCount}/${this._agentTotal}`,
			this._convoyText ? `Convoy: ${this._convoyText}` : null,
			`Mayor: ${this._mayorAttached ? 'attached' : 'detached'}`,
			this._terminalCount > 0 ? `Terminals: ${this._terminalCount}` : null,
			`Claude: ${this._claudeProvider}`,
		].filter(Boolean);
		this.item.tooltip = tooltipLines.join(' | ');
	}

	private computeHealth(): HealthLevel {
		if (!this._mayorAttached && this._agentTotal > 0 && this._agentCount === 0) {
			return 'warning';
		}
		if (this._agentCount > 0 || this._mayorAttached) {
			return 'healthy';
		}
		return 'healthy';
	}

	private async promptVertexFields(
		config: vscode.WorkspaceConfiguration,
		target: vscode.ConfigurationTarget,
	): Promise<void> {
		const projectId = await vscode.window.showInputBox({
			title: 'Vertex AI — Project ID',
			prompt: 'Google Cloud project ID',
			value: config.get<string>('vertex.projectId', ''),
			placeHolder: 'gen-ai-preview',
		});
		if (projectId !== undefined) {
			await config.update('vertex.projectId', projectId, target);
		}

		const region = await vscode.window.showInputBox({
			title: 'Vertex AI — Region',
			prompt: 'Vertex AI region',
			value: config.get<string>('vertex.region', 'global'),
			placeHolder: 'global',
		});
		if (region !== undefined) {
			await config.update('vertex.region', region, target);
		}
	}

	private async promptBedrockFields(
		config: vscode.WorkspaceConfiguration,
		target: vscode.ConfigurationTarget,
	): Promise<void> {
		const region = await vscode.window.showInputBox({
			title: 'Amazon Bedrock — Region',
			prompt: 'AWS region',
			value: config.get<string>('bedrock.region', 'us-east-1'),
			placeHolder: 'us-east-1',
		});
		if (region !== undefined) {
			await config.update('bedrock.region', region, target);
		}
	}

	private async promptAnthropicFields(
		config: vscode.WorkspaceConfiguration,
		target: vscode.ConfigurationTarget,
	): Promise<void> {
		const apiKey = await vscode.window.showInputBox({
			title: 'Anthropic — API Key',
			prompt: 'API key (leave blank to use ANTHROPIC_API_KEY from your shell)',
			value: config.get<string>('anthropic.apiKey', ''),
			placeHolder: 'sk-ant-...',
			password: true,
		});
		if (apiKey !== undefined) {
			await config.update('anthropic.apiKey', apiKey, target);
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
