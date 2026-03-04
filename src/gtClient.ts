/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getEnvWithPath, resolveCommand } from './cli/env';
import { ProcessSupervisor } from './cli/processSupervisor';
import { SWRCache } from './cli/swrCache';
import { INFRASTRUCTURE_ROLES, ROLE_MAP, EMOJI_ROLE_MAP, CANONICAL_ROLE_MAP, DEFAULT_HEARTBEAT_STALE_MINUTES, type PolecatState, type AgentDisplayStatus } from './constants';

function requireChildProcess(): typeof import('child_process') {
	try {
		return require('child_process');
	} catch {
		throw new Error('child_process module is not available. This extension requires a Node.js extension host.');
	}
}

export interface GtAgent {
	name: string;
	status: string;
	displayStatus: AgentDisplayStatus;
	rig: string;
	role: string;
	address?: string;
	session?: string;
	running: boolean;
	hasWork: boolean;
	polecatState?: PolecatState;
	beadId?: string;
	pid?: number;
	unreadMail?: number;
	firstSubject?: string;
	currentTask?: string;
}

export interface GtConvoy {
	id: string;
	title: string;
	tracked: GtBead[];
	status: string;
	progress: { completed: number; total: number };
}

export interface GtBead {
	id: string;
	title: string;
	status: string;
	assignee?: string;
	issue_type?: string;
	labels?: string[];
	priority?: number;
}

export interface DashboardSummary {
	// Stats
	polecatCount: number;
	hookCount: number;
	issueCount: number;
	convoyCount: number;
	escalationCount: number;

	// Alerts
	stuckPolecats: number;
	staleHooks: number;
	unackedEscalations: number;
	deadSessions: number;
	highPriorityIssues: number;

	// Computed
	hasAlerts: boolean;
}

export interface BeadListOptions {
	noParent?: boolean;
	status?: string;
	all?: boolean;
	parent?: string;
}

export interface GtRig {
	name: string;
	repoUrl: string;
	hooks: GtHook[];
	crewMembers: string[];
}

export interface GtHook {
	name: string;
	status: string;
	agent?: string;
	branch?: string;
}

export interface GtMayorStatus {
	running: boolean;
	attached: boolean;
	pid?: number;
	uptime?: string;
}

export interface DaemonHealth {
	running: boolean;
	pid?: number;
	staleHeartbeat: boolean;
	heartbeatAge?: string;
	crashLoops: { agent: string; since: string; restartCount: number }[];
	staleAgentConfig: boolean;
	staleAgentCommand?: string;
}

export type DaemonIssue =
	| { kind: 'not-running' }
	| { kind: 'crash-loop'; agent: string; since: string; restartCount: number }
	| { kind: 'stale-agent-config'; command: string }
	| { kind: 'stale-heartbeat'; age: string };

/** Dolt SQL server port (used by both gt and bd). */
export const DOLT_PORT = 3307;

export interface DoltHealth {
	reachable: boolean;
	pid?: number;
}

export class GtClient {
	private gtPath: string;
	private bdPath: string;
	private workspacePath: string;
	private readonly gtSupervisor: ProcessSupervisor;
	private readonly bdSupervisor: ProcessSupervisor;
	private readonly cache = new SWRCache();

	constructor() {
		const config = vscode.workspace.getConfiguration('citadel');
		this.gtPath = resolveCommand(config.get<string>('gtPath', 'gt'));
		this.bdPath = resolveCommand(config.get<string>('bdPath', 'bd'));
		this.workspacePath = config.get<string>('workspacePath', '~/gt').replace('~', os.homedir());
		this.gtSupervisor = new ProcessSupervisor();
		this.bdSupervisor = new ProcessSupervisor();
	}

	reload(): void {
		const config = vscode.workspace.getConfiguration('citadel');
		this.gtPath = resolveCommand(config.get<string>('gtPath', 'gt'));
		this.bdPath = resolveCommand(config.get<string>('bdPath', 'bd'));
		this.workspacePath = config.get<string>('workspacePath', '~/gt').replace('~', os.homedir());
		this.cache.clear();
	}

	dispose(): void {
		this.gtSupervisor.destroy();
		this.bdSupervisor.destroy();
		this.cache.clear();
	}

	/**
	 * Execute a gt CLI command via the ProcessSupervisor (concurrency-limited,
	 * deduplicated, circuit-breaker protected).
	 */
	private async exec(args: string[]): Promise<string> {
		const result = await this.gtSupervisor.execute<unknown>({
			command: this.gtPath,
			args,
			cwd: this.workspacePath,
		});
		if (!result.success) {
			throw new Error(`gt ${args.join(' ')} failed: ${result.error}`);
		}
		if (result.data === null || result.data === undefined) { return ''; }
		return typeof result.data === 'string' ? result.data.trim() : JSON.stringify(result.data);
	}

	/**
	 * SWR-cached exec for read-only gt commands. Identical commands within
	 * the TTL window return cached results, eliminating duplicate CLI calls
	 * within a single refresh cycle.
	 */
	private cachedExec(args: string[], ttlMs: number = 4000): Promise<string> {
		const key = `gt:${args.join(':')}`;
		return this.cache.get(key, ttlMs, () => this.exec(args));
	}

	private cachedExecBd(args: string[], ttlMs: number = 4000): Promise<string> {
		const key = `bd:${args.join(':')}`;
		return this.cache.get(key, ttlMs, () => this.execBd(args));
	}

	static readonly INFRASTRUCTURE_ROLES = INFRASTRUCTURE_ROLES;

	static isInfrastructureRole(role: string): boolean {
		return INFRASTRUCTURE_ROLES.has(role);
	}

	private static inferRole(name: string, emoji?: string): string {
		if (emoji && EMOJI_ROLE_MAP[emoji]) {
			return EMOJI_ROLE_MAP[emoji];
		}
		if (EMOJI_ROLE_MAP[name]) {
			return EMOJI_ROLE_MAP[name];
		}
		const lower = name.toLowerCase();
		return ROLE_MAP[lower] ?? 'polecat';
	}

	/** Normalize role names from the CLI (e.g. 'coordinator' -> 'mayor'). */
	private static normalizeRole(role: string): string {
		return CANONICAL_ROLE_MAP[role] || role;
	}

	private static deriveDisplayStatus(running: boolean, hasWork: boolean, state?: string): AgentDisplayStatus {
		if (state === 'dead') { return 'dead'; }
		if (state === 'stuck') { return 'stuck'; }
		if (state === 'done') { return 'completing'; }
		if (state === 'working') { return 'running'; }
		if (!running) { return 'exited'; }
		if (hasWork) { return 'running'; }
		return 'idle';
	}

	private static deriveTask(
		agent: { has_work?: boolean; first_subject?: string; running?: boolean },
		hook?: { bead_id?: string; has_work?: boolean },
	): string | undefined {
		if (hook?.bead_id) { return `Working on ${hook.bead_id}`; }
		if (agent.first_subject) { return agent.first_subject; }
		if (agent.has_work) { return 'Processing work'; }
		if (agent.running === false) { return 'Not running'; }
		return undefined;
	}

	/**
	 * Primary data source: `gt status --json`.
	 * Returns all agents from both top-level and per-rig, with hook cross-referencing.
	 * Falls back to the older `gt agents list -a` on failure OR if the result is empty
	 * (empty results from a supposedly-valid response are suspicious).
	 */
	async getAgents(): Promise<GtAgent[]> {
		try {
			const agents = await this.getAgentsFromStatus();
			if (agents.length > 0) { return agents; }
		} catch { /* fall through to list-based approach */ }

		try {
			const agents = await this.getAgentsFromList();
			if (agents.length > 0) { return agents; }
		} catch { /* fall through to text parsing */ }

		return this.getAgentsFromTextFallback();
	}

	private async getAgentsFromStatus(): Promise<GtAgent[]> {
		const [output, polecatStates] = await Promise.all([
			this.cachedExec(['status', '--json']),
			this.getPolecatStates(),
		]);
		const data = JSON.parse(output);
		const agents: GtAgent[] = [];

		const topLevel = data.agents || [];
		const rigs = data.rigs || [];

		console.log(`[Citadel] gt status --json: ${topLevel.length} top-level agents, ${rigs.length} rigs`);

		for (const a of topLevel) {
			agents.push(GtClient.mapStatusAgent(a));
		}

		for (const rig of rigs) {
			const rigAgents = rig.agents || [];
			const hookMap = new Map<string, { bead_id?: string; has_work?: boolean }>();
			for (const h of (rig.hooks || [])) {
				hookMap.set(h.agent, h);
			}

			console.log(`[Citadel]   rig "${rig.name}": ${rigAgents.length} agents, ${(rig.hooks || []).length} hooks`);

			for (const a of rigAgents) {
				const hook = hookMap.get(a.address || a.name);
				// Supplement rig agents with polecat state data from gt polecat list.
				// gt status --json omits the state field for rig-level agents,
				// causing polecats to appear idle even when working.
				const polecatKey = `${rig.name}/${a.name}`;
				const pState = polecatStates.get(polecatKey);
				if (pState && !a.state) {
					a.state = pState.state;
				}
				if (pState?.issue && !hook?.bead_id) {
					if (!hook) {
						hookMap.set(a.address || a.name, { bead_id: pState.issue, has_work: true });
					} else {
						hook.bead_id = pState.issue;
						hook.has_work = true;
					}
				}
				const effectiveHook = hookMap.get(a.address || a.name);
				agents.push(GtClient.mapStatusAgent(a, rig.name, effectiveHook));
			}
		}

		console.log(`[Citadel] getAgentsFromStatus total: ${agents.length}`);
		return agents;
	}

	/**
	 * Fetch polecat states from `gt polecat list --all --json`.
	 * Returns a map keyed by "rigName/polecatName" with state and issue info.
	 * This supplements `gt status --json` which omits state for rig-level agents.
	 */
	private async getPolecatStates(): Promise<Map<string, { state: string; issue?: string }>> {
		const map = new Map<string, { state: string; issue?: string }>();
		try {
			const output = await this.cachedExec(['polecat', 'list', '--all', '--json']);
			const data = JSON.parse(output);
			if (Array.isArray(data)) {
				for (const p of data) {
					const key = `${p.rig}/${p.name}`;
					map.set(key, { state: p.state, issue: p.issue });
				}
			}
		} catch {
			// polecat list may not be available — continue without supplemental data
		}
		return map;
	}

	private static mapStatusAgent(
		a: Record<string, unknown>,
		rigName?: string,
		hook?: { bead_id?: string; has_work?: boolean },
	): GtAgent {
		const rawRole = String(a.role || 'polecat');
		const role = GtClient.normalizeRole(rawRole);
		const running = Boolean(a.running);
		const hasWork = Boolean(a.has_work);
		const state = typeof a.state === 'string' ? a.state : undefined;
		const displayStatus = GtClient.deriveDisplayStatus(running, hasWork, state);

		let legacyStatus: string;
		switch (displayStatus) {
			case 'running': legacyStatus = 'active'; break;
			case 'idle': legacyStatus = 'idle'; break;
			case 'completing': legacyStatus = 'completed'; break;
			case 'stuck': legacyStatus = 'error'; break;
			case 'dead': legacyStatus = 'stopped'; break;
			case 'exited': legacyStatus = 'stopped'; break;
		}

		const polecatState = (role === 'polecat' || role === 'crew') && state
			? state as PolecatState
			: undefined;

		return {
			name: String(a.name || ''),
			status: legacyStatus,
			displayStatus,
			rig: rigName || '',
			role,
			address: typeof a.address === 'string' ? a.address : undefined,
			session: typeof a.session === 'string' ? a.session : undefined,
			running,
			hasWork,
			polecatState,
			beadId: hook?.bead_id || undefined,
			pid: typeof a.pid === 'number' ? a.pid : undefined,
			unreadMail: typeof a.unread_mail === 'number' ? a.unread_mail : undefined,
			firstSubject: typeof a.first_subject === 'string' ? a.first_subject : undefined,
			currentTask: GtClient.deriveTask(
				{ has_work: hasWork, first_subject: a.first_subject as string | undefined, running },
				hook,
			),
		};
	}

	/** Fallback: `gt agents list -a --json` */
	private async getAgentsFromList(): Promise<GtAgent[]> {
		const output = await this.exec(['agents', 'list', '-a']);
		const data = JSON.parse(output);
		if (!Array.isArray(data)) { return []; }

		return data.map((a: Record<string, unknown>) => {
			const role = String(a.role || 'polecat');
			const statusStr = String(a.status || 'active').toLowerCase();
			const running = statusStr === 'active' || statusStr === 'working';
			const hasWork = statusStr === 'working';
			return {
				name: String(a.name || ''),
				status: statusStr,
				displayStatus: GtClient.deriveDisplayStatus(running, hasWork),
				rig: String(a.rig || a.rig_name || ''),
				role,
				running,
				hasWork,
				beadId: (a.bead_id || a.beadId) as string | undefined,
				pid: typeof a.pid === 'number' ? a.pid : undefined,
			};
		});
	}

	/** Last-resort text parsing fallback for non-JSON CLI output. */
	private async getAgentsFromTextFallback(): Promise<GtAgent[]> {
		try {
			const output = await this.exec(['agents', 'list', '-a']);
			const agents: GtAgent[] = [];
			const lines = output.split('\n').filter(l => l.trim());
			for (const line of lines) {
				const statusMatch = line.match(/(🎩|🐺|👷|🐱)?\s*(\S+)\s+(active|idle|completed|working|stopped)\s+(\S*)/iu);
				if (statusMatch) {
					const emoji = statusMatch[1];
					const name = statusMatch[2];
					const statusStr = statusMatch[3].toLowerCase();
					const running = statusStr === 'active' || statusStr === 'working';
					const hasWork = statusStr === 'working';
					agents.push({
						name,
						status: statusStr,
						displayStatus: GtClient.deriveDisplayStatus(running, hasWork),
						rig: statusMatch[4] || '',
						role: GtClient.inferRole(name, emoji),
						running,
						hasWork,
					});
					continue;
				}
				const nameMatch = line.match(/(🎩|🐺|👷|🐱)?\s*(\S+)/u);
				if (nameMatch) {
					const emoji = nameMatch[1];
					const name = nameMatch[2] || line.replace(/[^\w-]/g, '').trim();
					if (name) {
						agents.push({
							name,
							status: 'active',
							displayStatus: 'running',
							rig: '',
							role: GtClient.inferRole(name, emoji),
							running: true,
							hasWork: false,
						});
					}
				}
			}
			return agents;
		} catch {
			return [];
		}
	}

	async getWorkerAgents(): Promise<GtAgent[]> {
		const all = await this.getAgents();
		return all.filter(a => !GtClient.INFRASTRUCTURE_ROLES.has(a.role));
	}

	async getInfrastructureAgents(): Promise<GtAgent[]> {
		const all = await this.getAgents();
		return all.filter(a => GtClient.INFRASTRUCTURE_ROLES.has(a.role));
	}

	async getSummary(): Promise<DashboardSummary> {
		const [agents, rigs, beads, convoys] = await Promise.all([
			this.getAgents().catch(() => [] as GtAgent[]),
			this.getRigs().catch(() => [] as GtRig[]),
			this.listBeads({ status: 'open' }).catch(() => [] as GtBead[]),
			this.getConvoys().catch(() => [] as GtConvoy[]),
		]);

		const workers = agents.filter(a => !GtClient.isInfrastructureRole(a.role));
		const hooks = rigs.flatMap(r => r.hooks);

		let stuckPolecats = 0;
		let deadSessions = 0;
		for (const a of workers) {
			if (a.displayStatus === 'stuck' || a.polecatState === 'stuck') { stuckPolecats++; }
			if (a.displayStatus === 'dead') { deadSessions++; }
		}

		let staleHooks = 0;
		for (const h of hooks) {
			if (h.status === 'stale') { staleHooks++; }
		}

		let escalationCount = 0;
		let highPriorityIssues = 0;
		for (const b of beads) {
			if (b.status === 'escalated') { escalationCount++; }
			// Skip infrastructure beads, wisps, convoy trackers, molecules,
			// and rig/polecat/refinery/witness registration beads
			if (b.id.includes('wisp') || b.id.includes('-cv-') ||
				b.id.includes('-mol-') || b.id.includes('-polecat-') ||
				b.id.includes('-refinery') || b.id.includes('-witness') ||
				b.id.startsWith('hq-deacon') || b.id.startsWith('hq-mayor') ||
				b.id.includes('-rig-')) { continue; }
			if (b.priority !== undefined && (b.priority === 1 || b.priority === 2)) { highPriorityIssues++; }
		}

		const hasAlerts = stuckPolecats > 0 || staleHooks > 0 ||
			escalationCount > 0 || deadSessions > 0 || highPriorityIssues > 0;

		return {
			polecatCount: workers.length,
			hookCount: hooks.length,
			issueCount: beads.length,
			convoyCount: convoys.length,
			escalationCount,
			stuckPolecats,
			staleHooks,
			unackedEscalations: escalationCount,
			deadSessions,
			highPriorityIssues,
			hasAlerts,
		};
	}

	async getConvoys(): Promise<GtConvoy[]> {
		try {
			const output = await this.cachedExec(['convoy', 'list', '--json']);
			const data = JSON.parse(output);
			if (Array.isArray(data)) {
				return data.map((c: any) => ({
					id: c.id || '',
					title: c.title || '',
					tracked: (c.tracked || []).map((b: any) => ({
						id: b.id || '',
						title: b.title || b.id || '',
						status: b.status || 'pending',
						assignee: b.assignee,
					})),
					status: c.status || 'active',
					progress: {
						completed: c.completed ?? 0,
						total: c.total ?? 0,
					},
				}));
			}
			return [];
		} catch {
			return this.getConvoysFallback();
		}
	}

	private async getConvoysFallback(): Promise<GtConvoy[]> {
		try {
			const output = await this.exec(['convoy', 'list']);
			const convoys: GtConvoy[] = [];
			const lines = output.split('\n').filter(l => l.trim());
			for (const line of lines) {
				const match = line.match(/(\S+)\s+"?([^"]+)"?\s+(\d+)\/(\d+)/);
				if (match) {
					convoys.push({
						id: match[1],
						title: match[2].trim(),
						tracked: [],
						status: 'active',
						progress: { completed: parseInt(match[3]), total: parseInt(match[4]) },
					});
				}
			}
			return convoys;
		} catch {
			return [];
		}
	}

	async getRigs(): Promise<GtRig[]> {
		try {
			return await this.getRigsFromStatus();
		} catch { /* fall through */ }

		try {
			return await this.getRigsFromList();
		} catch {
			return this.getRigsFallback();
		}
	}

	/**
	 * Primary: `gt status --json` provides hooks and crew data per rig.
	 * `gt rig list --json` only returns summary counts (no hooks/crew arrays),
	 * so we source from `gt status --json` instead.
	 */
	private async getRigsFromStatus(): Promise<GtRig[]> {
		const output = await this.cachedExec(['status', '--json']);
		const data = JSON.parse(output);
		const rigs = data.rigs || [];
		if (!Array.isArray(rigs) || rigs.length === 0) { return []; }

		return rigs.map((r: any) => {
			const rigName = r.name || '';
			const hooks: GtHook[] = (r.hooks || []).map((h: any) => {
				const agent = h.agent || '';
				// Extract short name from address (e.g., "CityHallRig/nux" → "nux")
				const name = agent.includes('/') ? agent.split('/').pop()! : agent;
				const status = h.has_work ? 'active' : 'idle';
				return { name, status, agent, branch: h.branch };
			});

			const crewMembers: string[] = Array.isArray(r.crews) ? r.crews : [];

			return {
				name: rigName,
				repoUrl: r.repo_url || '',
				hooks,
				crewMembers,
			};
		});
	}

	/** Fallback: `gt rig list --json` (returns summary counts, no hook/crew details). */
	private async getRigsFromList(): Promise<GtRig[]> {
		const output = await this.exec(['rig', 'list', '--json']);
		const data = JSON.parse(output);
		if (Array.isArray(data)) {
			return data.map((r: any) => ({
				name: r.name || '',
				repoUrl: r.repo_url || r.repoUrl || '',
				hooks: (r.hooks || []).map((h: any) => ({
					name: h.name || '',
					status: h.status || 'unknown',
					agent: h.agent,
					branch: h.branch,
				})),
				crewMembers: r.crew_members || r.crewMembers || [],
			}));
		}
		return [];
	}

	/** Last-resort text parsing fallback for non-JSON CLI output. */
	private async getRigsFallback(): Promise<GtRig[]> {
		try {
			const output = await this.exec(['rig', 'list']);
			const rigs: GtRig[] = [];
			const lines = output.split('\n').filter(l => l.trim());
			for (const line of lines) {
				const match = line.match(/(\S+)\s+(https?:\/\/\S+|\S+\.git)/);
				if (match) {
					rigs.push({
						name: match[1],
						repoUrl: match[2],
						hooks: [],
						crewMembers: [],
					});
				}
			}
			return rigs;
		} catch {
			return [];
		}
	}

	async getMayorStatus(): Promise<GtMayorStatus> {
		try {
			const output = await this.cachedExec(['mayor', 'status', '--json']);
			const data = JSON.parse(output);
			return {
				running: data.running ?? (data.attached || data.status !== 'stopped'),
				attached: data.attached || data.status === 'attached',
				pid: data.pid,
				uptime: data.uptime,
			};
		} catch {
			return this.getMayorStatusFallback();
		}
	}

	private async getMayorStatusFallback(): Promise<GtMayorStatus> {
		try {
			const output = await this.exec(['mayor', 'status']);
			const isRunning = /running|active/i.test(output) && !/not running/i.test(output);
			const isAttached = /attached/i.test(output) && !/not attached|detached/i.test(output);
			return { running: isRunning, attached: isAttached };
		} catch {
			return { running: false, attached: false };
		}
	}

	async slingBead(beadId: string, rig: string, agentOverride?: string): Promise<string> {
		const args = ['sling', beadId, rig];
		if (agentOverride) {
			args.push('--agent', agentOverride);
		}
		return this.exec(args);
	}

	async isDoltRunning(port = 3307): Promise<boolean> {
		const net = require('net') as typeof import('net');
		return new Promise<boolean>((resolve) => {
			const socket = net.createConnection({ port, host: '127.0.0.1' });
			socket.setTimeout(2000);
			socket.on('connect', () => { socket.destroy(); resolve(true); });
			socket.on('timeout', () => { socket.destroy(); resolve(false); });
			socket.on('error', () => { resolve(false); });
		});
	}

	async startDolt(): Promise<string> {
		return this.exec(['dolt', 'start']);
	}

	async stopDolt(): Promise<void> {
		try {
			await this.exec(['dolt', 'stop']);
			return;
		} catch { /* stop may fail for stale PID — try to force-clean below */ }

		const pidMatch = await this.findDoltPid();
		if (pidMatch) {
			try { process.kill(pidMatch, 'SIGKILL'); } catch { /* already dead */ }
		}
		this.cleanDoltPidFiles();
	}

	async restartDolt(): Promise<string> {
		await this.stopDolt();
		await new Promise(r => setTimeout(r, 500));
		return this.exec(['dolt', 'start']);
	}

	private async findDoltPid(): Promise<number | undefined> {
		const pidLocations = [
			path.join(this.workspacePath, 'dolt', 'dolt.pid'),
			path.join(this.workspacePath, '.dolt', 'dolt.pid'),
			path.join(this.workspacePath, 'dolt.pid'),
		];
		for (const p of pidLocations) {
			if (fs.existsSync(p)) {
				try {
					const content = fs.readFileSync(p, 'utf-8').trim();
					const pid = parseInt(content, 10);
					if (!isNaN(pid)) { return pid; }
				} catch { /* ignore */ }
			}
		}
		return undefined;
	}

	private cleanDoltPidFiles(): void {
		const pidLocations = [
			path.join(this.workspacePath, 'dolt', 'dolt.pid'),
			path.join(this.workspacePath, '.dolt', 'dolt.pid'),
			path.join(this.workspacePath, 'dolt.pid'),
		];
		for (const p of pidLocations) {
			try { if (fs.existsSync(p)) { fs.unlinkSync(p); } } catch { /* ignore */ }
		}
	}

	async getDoltHealth(): Promise<DoltHealth> {
		const [reachable, pid] = await Promise.all([
			this.isDoltRunning(DOLT_PORT),
			this.findDoltPid(),
		]);
		return { reachable, pid };
	}

	async createConvoy(name: string, beadIds: string[], notify = true): Promise<string> {
		const args = ['convoy', 'create', name, ...beadIds];
		if (notify) {
			args.push('--notify');
		}
		return this.exec(args);
	}

	async convoyShow(convoyId?: string): Promise<string> {
		const args = ['convoy', 'show'];
		if (convoyId) {
			args.push(convoyId);
		}
		return this.exec(args);
	}

	async attachMayor(): Promise<string> {
		return this.exec(['mayor', 'attach']);
	}

	async detachMayor(): Promise<string> {
		return this.exec(['mayor', 'stop']);
	}

	async addRig(name: string, repoUrl: string): Promise<string> {
		return this.exec(['rig', 'add', name, repoUrl]);
	}

	async addCrew(name: string, rig: string): Promise<string> {
		return this.exec(['crew', 'add', name, '--rig', rig]);
	}

	async killAgent(agentName: string, role?: string, rig?: string): Promise<string> {
		const effectiveRole = role || EMOJI_ROLE_MAP[agentName];

		switch (effectiveRole) {
			case 'mayor':
				return this.exec(['mayor', 'stop']);
			case 'deacon':
				return this.exec(['deacon', 'stop']);
			case 'witness':
			case 'refinery':
			case 'dog':
				return this.exec([effectiveRole, 'stop']);
			default: {
				if (!rig) {
					throw new Error(
						`Cannot kill agent "${agentName}": no rig specified. ` +
						`The force-kill command requires an address in rig/role/name format.`,
					);
				}
				const address = role ? `${rig}/${role}/${agentName}` : `${rig}/${agentName}`;
				return this.exec(['deacon', 'force-kill', address]);
			}
		}
	}

	async restartAgent(agentName: string, role?: string, _rig?: string): Promise<string> {
		const effectiveRole = role || EMOJI_ROLE_MAP[agentName];

		switch (effectiveRole) {
			case 'witness':
				return this.exec(['witness', 'restart']);
			case 'refinery':
				return this.exec(['refinery', 'restart']);
			case 'polecat':
			case 'crew': {
				if (!agentName) {
					throw new Error('Agent name is required for polecat restart');
				}
				return this.exec(['polecat', 'restart', agentName]);
			}
			case 'mayor':
			case 'deacon':
				throw new Error(
					`Cannot restart ${effectiveRole} directly. Use stop + start instead.`,
				);
			default: {
				return this.exec([effectiveRole || 'polecat', 'restart', agentName]);
			}
		}
	}

	async hooksRepair(): Promise<string> {
		return this.exec(['hooks', 'repair']);
	}

	async openDashboard(port?: number): Promise<import('child_process').ChildProcess> {
		const cp = requireChildProcess();
		const args = ['dashboard'];
		if (port) {
			args.push('--port', port.toString());
		}
	return cp.spawn(this.gtPath, args, {
		cwd: this.workspacePath,
		env: getEnvWithPath(),
		detached: true,
		stdio: 'ignore',
	});
	}

	getClaudeEnv(): Record<string, string> {
		const config = vscode.workspace.getConfiguration('citadel.claude');
		const provider = config.get<string>('provider', 'none');

		switch (provider) {
			case 'vertex': {
				const projectId = config.get<string>('vertex.projectId', '');
				const region = config.get<string>('vertex.region', 'global');
				const env: Record<string, string> = {
					CLAUDE_CODE_USE_VERTEX: '1',
					CLOUD_ML_REGION: region,
				};
				if (projectId) {
					env.ANTHROPIC_VERTEX_PROJECT_ID = projectId;
				}
				const adcPath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
				if (adcPath) {
					env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
				}
				return env;
			}

			case 'bedrock': {
				const region = config.get<string>('bedrock.region', 'us-east-1');
				return {
					CLAUDE_CODE_USE_BEDROCK: '1',
					AWS_REGION: region,
				};
			}

			case 'anthropic': {
				const apiKey = config.get<string>('anthropic.apiKey', '');
				if (apiKey) {
					return { ANTHROPIC_API_KEY: apiKey };
				}
				return {};
			}

			default:
				return {};
		}
	}

	/**
	 * Sync Claude provider env vars and PATH into the tmux global environment
	 * so every Gas Town session inherits them.  Also removes any stale agent
	 * command override that would break the daemon's process-name detection
	 * (registering a wrapper via `gt config agent set claude` causes
	 * GT_PROCESS_NAMES to resolve to the wrapper name instead of "node,claude",
	 * making the daemon think every session is a zombie).
	 */
	async syncClaudeWrapper(): Promise<string | undefined> {
		const cp = requireChildProcess();
		const claudeEnv = this.getClaudeEnv();
		const entries = Object.entries(claudeEnv);

		// Remove stale wrapper-based agent override so gt uses the built-in
		// claude preset (correct GT_PROCESS_NAMES = "node,claude").
		await this.removeStaleAgentWrapper();

		// Set PATH enrichment in the tmux global environment so all sessions
		// (including daemon-created ones) can find gt, bd, and go binaries.
		const enrichedPath = [
			path.join(os.homedir(), '.local', 'bin'),
			path.join(os.homedir(), 'go', 'bin'),
			process.env['PATH'] || '',
		].join(':');

		this.tmuxSetGlobalEnv(cp, 'PATH', enrichedPath);

		// Enable mouse mode so scroll works in VS Code terminals attached to tmux
		try {
			cp.execFileSync('tmux', ['set', '-g', 'mouse', 'on'], {
				timeout: 5_000,
				stdio: 'ignore',
			});
		} catch {
			// tmux server may not be running yet
		}

		// Set Claude provider env vars (Vertex, Bedrock, Anthropic).
		for (const [k, v] of entries) {
			this.tmuxSetGlobalEnv(cp, k, v);
		}

		return entries.length > 0 ? 'tmux-env' : undefined;
	}

	/**
	 * Remove any stale wrapper-based agent override and clean up the old
	 * wrapper file.  Idempotent — safe to call even if nothing was registered.
	 */
	private async removeStaleAgentWrapper(): Promise<void> {
		// Try the CLI first, fall back to manual config edit, or just
		// ignore if there's nothing to remove.
		try {
			await this.exec(['config', 'agent', 'remove', 'claude']);
		} catch {
			try { await this.repairStaleAgentConfig(); } catch { /* nothing to remove */ }
		}

		const wrapperPath = path.join(this.workspacePath, '.citadel', 'claude-wrapper.sh');
		if (fs.existsSync(wrapperPath)) {
			try { fs.unlinkSync(wrapperPath); } catch { /* best effort */ }
		}
	}

	private tmuxSetGlobalEnv(cp: typeof import('child_process'), key: string, value: string): void {
		try {
			cp.execFileSync('tmux', ['set-environment', '-g', key, value], {
				timeout: 5_000,
				stdio: 'ignore',
			});
		} catch {
			// tmux server may not be running yet — will be set on next sync
		}
	}

	// ---- Beads (bd CLI) -------------------------------------------------------

	/**
	 * Execute a bd CLI command via the ProcessSupervisor (concurrency-limited,
	 * deduplicated, circuit-breaker protected).
	 */
	private async execBd(args: string[]): Promise<string> {
		const result = await this.bdSupervisor.execute<unknown>({
			command: this.bdPath,
			args,
			cwd: this.workspacePath,
		});
		if (!result.success) {
			throw new Error(`bd ${args.join(' ')} failed: ${result.error}`);
		}
		if (result.data === null || result.data === undefined) { return ''; }
		return typeof result.data === 'string' ? result.data.trim() : JSON.stringify(result.data);
	}

	async listBeads(options?: BeadListOptions): Promise<GtBead[]> {
		try {
			const args = ['list', '--json'];
			if (options?.noParent) {
				args.push('--no-parent');
			}
			if (options?.status) {
				args.push('--status', options.status);
			}
			if (options?.all) {
				args.push('--all');
			}
			if (options?.parent) {
				args.push('--parent', options.parent);
			}

			// Query town-level beads and all rig-level beads in parallel
			const rigNames = await this.getRigNames();
			const queries: Promise<string>[] = [this.cachedExecBd(args)];
			for (const rig of rigNames) {
				queries.push(this.cachedExecBd([...args, '--rig', rig]));
			}

			const results = await Promise.all(queries.map(q => q.catch(() => '[]')));
			const seen = new Set<string>();
			const beads: GtBead[] = [];

			for (const output of results) {
				try {
					const data = JSON.parse(output);
					if (Array.isArray(data)) {
						for (const b of data) {
							const id = b.id || '';
							if (id && !seen.has(id)) {
								seen.add(id);
								beads.push({
									id,
									title: b.title || b.summary || id || '',
									status: b.status || 'pending',
									assignee: b.assignee,
									issue_type: b.issue_type,
									labels: Array.isArray(b.labels) ? b.labels : undefined,
									priority: typeof b.priority === 'number' ? b.priority : undefined,
								});
							}
						}
					}
				} catch { /* skip unparseable result */ }
			}

			return beads;
		} catch {
			return this.listBeadsFallback();
		}
	}

	/** Get rig names for multi-rig bead queries. */
	private async getRigNames(): Promise<string[]> {
		try {
			const rigs = await this.getRigs();
			return rigs.map(r => r.name).filter(Boolean);
		} catch {
			return [];
		}
	}

	private async listBeadsFallback(): Promise<GtBead[]> {
		try {
			const output = await this.execBd(['list']);
			const beads: GtBead[] = [];
			const lines = output.split('\n').filter(l => l.trim());
			for (const line of lines) {
				const match = line.match(/(\S+)\s+(.+?)\s{2,}(\S+)/);
				if (match) {
					beads.push({
						id: match[1],
						title: match[2].trim(),
						status: match[3].toLowerCase(),
					});
				}
			}
			return beads;
		} catch {
			return [];
		}
	}

	async createBead(title: string): Promise<string> {
		return this.execBd(['create', title]);
	}

	async deleteBead(beadId: string): Promise<string> {
		return this.execBd(['delete', beadId]);
	}

	async showBead(beadId: string): Promise<string> {
		return this.execBd(['show', beadId]);
	}

	// ---- Daemon health & repair ------------------------------------------------

	async getDaemonHealth(): Promise<DaemonHealth> {
		const health: DaemonHealth = {
			running: false,
			staleHeartbeat: false,
			crashLoops: [],
			staleAgentConfig: false,
		};

		const statePath = path.join(this.workspacePath, 'daemon', 'state.json');
		if (fs.existsSync(statePath)) {
			try {
				const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
				health.pid = state.pid;

				if (state.running && state.pid) {
					try {
						process.kill(state.pid, 0);
						health.running = true;
					} catch {
						health.running = false;
					}
				}

				if (state.last_heartbeat) {
					const lastBeat = new Date(state.last_heartbeat).getTime();
					const ageMs = Date.now() - lastBeat;
					const ageMin = Math.floor(ageMs / 60_000);
					if (ageMin > DEFAULT_HEARTBEAT_STALE_MINUTES) {
						health.staleHeartbeat = true;
						health.heartbeatAge = ageMin < 60
							? `${ageMin}m`
							: `${Math.floor(ageMin / 60)}h${ageMin % 60}m`;
					}
				}
			} catch { /* corrupt state file */ }
		}

		const restartPath = path.join(this.workspacePath, 'daemon', 'restart_state.json');
		if (fs.existsSync(restartPath)) {
			try {
				const restartState = JSON.parse(fs.readFileSync(restartPath, 'utf-8'));
			const GO_ZERO_TIME = '0001-01-01T00:00:00Z';
			for (const [agent, info] of Object.entries<any>(restartState.agents || {})) {
				if (info.crash_loop_since && info.crash_loop_since !== GO_ZERO_TIME) {
					health.crashLoops.push({
						agent,
						since: info.crash_loop_since,
						restartCount: info.restart_count || 0,
					});
				}
			}
			} catch { /* corrupt restart state */ }
		}

		const configPath = path.join(this.workspacePath, 'settings', 'config.json');
		if (fs.existsSync(configPath)) {
			try {
				const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
				const cmd = config?.agents?.claude?.command;
				if (cmd && !fs.existsSync(cmd)) {
					health.staleAgentConfig = true;
					health.staleAgentCommand = cmd;
				}
			} catch { /* corrupt config */ }
		}

		return health;
	}

	getDaemonIssues(health: DaemonHealth): DaemonIssue[] {
		const issues: DaemonIssue[] = [];

		if (!health.running) {
			issues.push({ kind: 'not-running' });
		}
		if (health.staleHeartbeat && health.heartbeatAge) {
			issues.push({ kind: 'stale-heartbeat', age: health.heartbeatAge });
		}
		for (const cl of health.crashLoops) {
			issues.push({ kind: 'crash-loop', ...cl });
		}
		if (health.staleAgentConfig && health.staleAgentCommand) {
			issues.push({ kind: 'stale-agent-config', command: health.staleAgentCommand });
		}

		return issues;
	}

	async startDaemon(): Promise<void> {
		try {
			await this.exec(['daemon', 'start']);
		} catch {
			const health = await this.getDaemonHealth();
			if (!health.running) {
				throw new Error('daemon failed to start and is not running');
			}
		}
	}

	async stopDaemon(): Promise<void> {
		await this.exec(['daemon', 'stop']);
	}

	async restartDaemon(): Promise<void> {
		try { await this.exec(['daemon', 'stop']); } catch { /* may not be running */ }
		try {
			await this.exec(['daemon', 'start']);
		} catch {
			// `start` can fail if the daemon is already running (race with an
			// external restart or a concurrent heartbeat).  Verify it's actually
			// up before propagating.
			const health = await this.getDaemonHealth();
			if (!health.running) {
				throw new Error('daemon failed to start and is not running');
			}
		}
	}

	async startDeacon(): Promise<void> {
		await this.exec(['deacon', 'start']);
	}

	async stopDeacon(): Promise<void> {
		await this.exec(['deacon', 'stop']);
	}

	async restartDeacon(): Promise<void> {
		try { await this.exec(['deacon', 'stop']); } catch { /* may not be running */ }
		await this.exec(['deacon', 'start']);
	}

	async clearCrashLoops(): Promise<void> {
		const restartPath = path.join(this.workspacePath, 'daemon', 'restart_state.json');
		if (fs.existsSync(restartPath)) {
			fs.writeFileSync(restartPath, JSON.stringify({ agents: {} }, null, 2));
		}
	}

	async repairStaleAgentConfig(): Promise<void> {
		try {
			await this.exec(['config', 'agent', 'remove', 'claude']);
		} catch {
			const configPath = path.join(this.workspacePath, 'settings', 'config.json');
			if (fs.existsSync(configPath)) {
				const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
				if (config?.agents?.claude) {
					delete config.agents.claude;
					if (Object.keys(config.agents).length === 0) {
						delete config.agents;
					}
					fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
				}
			}
		}
	}

	async cleanupOrphans(): Promise<string> {
		return this.exec(['cleanup', '--force']);
	}

	/**
	 * Detect and repair all daemon issues. Returns a summary of what was fixed.
	 */
	async repairDaemon(): Promise<string[]> {
		const health = await this.getDaemonHealth();
		const issues = this.getDaemonIssues(health);
		const fixes: string[] = [];

		if (issues.length === 0) {
			return ['No issues detected — daemon is healthy.'];
		}

		for (const issue of issues) {
			switch (issue.kind) {
				case 'stale-agent-config':
					await this.repairStaleAgentConfig();
					fixes.push(`Removed stale agent config (was pointing to ${issue.command})`);
					break;
				case 'crash-loop':
					await this.clearCrashLoops();
					fixes.push(`Cleared crash loop for ${issue.agent} (${issue.restartCount} restarts since ${new Date(issue.since).toLocaleString()})`);
					break;
				case 'stale-heartbeat':
				case 'not-running':
					// Handled below via daemon restart
					break;
			}
		}

		const needsRestart = issues.some(i =>
			i.kind === 'not-running' || i.kind === 'stale-heartbeat' || i.kind === 'crash-loop'
		);
		if (needsRestart) {
			await this.restartDaemon();
			fixes.push('Restarted daemon');
		}

		return fixes;
	}

	async debugAgents(): Promise<string> {
		const lines: string[] = [];

		lines.push('=== gt status --json (raw output) ===');
		let rawOutput: string;
		try {
			rawOutput = await this.exec(['status', '--json']);
			lines.push(rawOutput || '(empty)');
		} catch (err: unknown) {
			rawOutput = '';
			lines.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
			lines.push('Trying fallback: gt agents list -a');
			try {
				rawOutput = await this.exec(['agents', 'list', '-a']);
				lines.push(rawOutput || '(empty)');
			} catch (err2: unknown) {
				lines.push(`FALLBACK ERROR: ${err2 instanceof Error ? err2.message : String(err2)}`);
			}
		}

		lines.push('');
		lines.push('=== JSON parse attempt ===');
		try {
			const data = JSON.parse(rawOutput);
			const type = Array.isArray(data) ? 'array' : typeof data;
			lines.push(`Parsed OK — type: ${type}, keys: ${Object.keys(data).join(', ')}`);
			lines.push(JSON.stringify(data, null, 2));
		} catch (err: unknown) {
			lines.push(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
			lines.push('Will use text fallback parsing.');
		}

		lines.push('');
		lines.push('=== getAgents() parsed result ===');
		const agents = await this.getAgents();
		for (const a of agents) {
			const details = [
				`name=${JSON.stringify(a.name)}`,
				`role=${JSON.stringify(a.role)}`,
				`displayStatus=${a.displayStatus}`,
				`running=${a.running}`,
				`hasWork=${a.hasWork}`,
				`rig=${JSON.stringify(a.rig)}`,
				a.polecatState ? `polecatState=${a.polecatState}` : null,
				a.address ? `address=${a.address}` : null,
				a.beadId ? `bead=${a.beadId}` : null,
				a.unreadMail ? `mail=${a.unreadMail}` : null,
				a.currentTask ? `task=${a.currentTask}` : null,
			].filter(Boolean).join('  ');
			lines.push(`  ${details}`);
		}
		if (agents.length === 0) {
			lines.push('  (no agents)');
		}

		lines.push('');
		lines.push('=== Infrastructure filter ===');
		const shown = agents.filter(a => !GtClient.INFRASTRUCTURE_ROLES.has(a.role));
		const hidden = agents.filter(a => GtClient.INFRASTRUCTURE_ROLES.has(a.role));
		lines.push(`Workers shown (${shown.length}):`);
		for (const a of shown) {
			lines.push(`  ${a.name} [role=${a.role}, ${a.displayStatus}]`);
		}
		lines.push(`Infrastructure hidden (${hidden.length}):`);
		for (const a of hidden) {
			lines.push(`  ${a.name} [role=${a.role}, ${a.displayStatus}]`);
		}

		return lines.join('\n');
	}

	getWorkspacePath(): string {
		return this.workspacePath;
	}

	getGtPath(): string {
		return this.gtPath;
	}

	// ---- Activity feed (.events.jsonl) ------------------------------------------

	/**
	 * Read recent activity events from the workspace .events.jsonl file.
	 * Parses each line as JSON, assigns a category, and returns newest-first.
	 */
	getActivityEvents(limit: number = 100): import('./cli/contracts').ActivityEvent[] {
		const eventsPath = path.join(this.workspacePath, '.events.jsonl');
		if (!fs.existsSync(eventsPath)) { return []; }

		try {
			const content = fs.readFileSync(eventsPath, 'utf-8');
			const lines = content.split('\n').filter(l => l.trim());
			const events: import('./cli/contracts').ActivityEvent[] = [];

			for (const line of lines) {
				try {
					const raw = JSON.parse(line);
					events.push({
						ts: raw.ts ?? '',
						source: raw.source ?? '',
						type: raw.type ?? '',
						actor: raw.actor ?? '',
						payload: raw.payload ?? {},
						visibility: raw.visibility,
						category: GtClient.categorizeEvent(raw.type),
					});
				} catch { /* skip malformed lines */ }
			}

			// Return newest first, limited
			return events.reverse().slice(0, limit);
		} catch { return []; }
	}

	private static categorizeEvent(type: string): import('./cli/contracts').ActivityCategory {
		switch (type) {
			case 'spawn':
			case 'session_death':
			case 'handoff':
				return 'agent';
			case 'sling':
			case 'hook':
			case 'completion':
				return 'work';
			case 'mail':
				return 'comms';
			default:
				return 'system';
		}
	}

	// ---- Mail (gt CLI) --------------------------------------------------------

	/**
	 * Fetch mail from all known agent inboxes.
	 *
	 * The extension host runs without agent identity context (no GT_ROLE env),
	 * so `gt mail inbox --json` falls back to the overseer inbox which is
	 * typically empty.  To show all system mail we query each known agent
	 * address in parallel and aggregate the results.
	 */
	async getMailInbox(): Promise<import('./cli/contracts').GtMailMessage[]> {
		try {
			const addresses = await this.getMailAddresses();
			const results = await Promise.all(
				addresses.map(addr => this.getInboxForAddress(addr)),
			);

			// Aggregate and deduplicate by message ID
			const seen = new Set<string>();
			const all: import('./cli/contracts').GtMailMessage[] = [];
			for (const msgs of results) {
				for (const msg of msgs) {
					if (msg.id && !seen.has(msg.id)) {
						seen.add(msg.id);
						all.push(msg);
					}
				}
			}
			return all;
		} catch {
			return [];
		}
	}

	private async getMailAddresses(): Promise<string[]> {
		const addresses = new Set<string>();
		addresses.add('mayor/');
		try {
			const agents = await this.getAgents();
			for (const agent of agents) {
				if (agent.address) {
					addresses.add(agent.address);
				}
			}
		} catch {
			// Fall back to mayor-only on error
		}
		return [...addresses];
	}

	private async getInboxForAddress(address: string): Promise<import('./cli/contracts').GtMailMessage[]> {
		try {
			const output = await this.cachedExec(['mail', 'inbox', address, '--json']);
			const data = JSON.parse(output);
			return Array.isArray(data) ? data : [];
		} catch {
			return [];
		}
	}

	async getMailMessage(id: string): Promise<string> {
		return this.exec(['mail', 'show', id]);
	}

	async sendMail(to: string, subject: string, body: string, priority = 'normal', type = 'notification'): Promise<string> {
		const priorityMap: Record<string, string> = { urgent: '0', high: '1', normal: '2', low: '3' };
		const priorityInt = priorityMap[priority] ?? '2';
		return this.exec(['mail', 'send', to, '-s', subject, '-m', body, '--priority', priorityInt, '--type', type]);
	}

	async markMailRead(id: string): Promise<string> {
		return this.exec(['mail', 'mark-read', id]);
	}

	// ---- Merge Queue (gt CLI) -------------------------------------------------

	async getMergeQueue(): Promise<import('./cli/contracts').GtMergeQueueItem[]> {
		try {
			const rigs = await this.getRigs();
			const results = await Promise.all(rigs.map(async (rig) => {
				try {
					const output = await this.cachedExec(['mq', 'list', rig.name, '--json']);
					const data = JSON.parse(output);
					if (Array.isArray(data)) {
						return data.map((item: any) => this.parseMergeQueueItem(item, rig.name));
					}
					return [];
				} catch {
					return [];
				}
			}));
			return results.flat();
		} catch {
			return [];
		}
	}

	private parseMergeQueueItem(item: any, rigName: string): import('./cli/contracts').GtMergeQueueItem {
		// gt mq list returns beads-format items; map to extension contract
		const desc = item.description || '';
		const branchMatch = desc.match(/branch:\s*(\S+)/);
		const workerMatch = desc.match(/worker:\s*(\S+)/);
		const beadMatch = desc.match(/source_issue:\s*(\S+)/);

		return {
			id: item.id || '',
			rig: rigName,
			branch: branchMatch?.[1] || '',
			agent: workerMatch?.[1],
			bead_id: beadMatch?.[1],
			status: item.status === 'open' ? 'waiting' : item.status || 'waiting',
			position: item.priority ?? 0,
			title: item.title || '',
			created_at: item.created_at || '',
		};
	}

	async retryMergeRequest(rig: string, mrId: string): Promise<string> {
		return this.exec(['mq', 'retry', rig, mrId]);
	}

	async rejectMergeRequest(rig: string, mrId: string, reason: string): Promise<string> {
		return this.exec(['mq', 'reject', rig, mrId, '--reason', reason]);
	}

	async getMergeRequestStatus(mrId: string): Promise<string> {
		return this.exec(['mq', 'status', mrId]);
	}

	async nudgeRefinery(): Promise<string> {
		return this.exec(['refinery', 'restart']);
	}

	// ---- Escalations ----------------------------------------------------------

	async getEscalations(): Promise<import('./cli/contracts').GtEscalation[]> {
		try {
			const output = await this.cachedExec(['escalations', 'list', '--json']);
			const data = JSON.parse(output);
			return Array.isArray(data) ? data : [];
		} catch {
			return [];
		}
	}

	async resolveEscalation(id: string, decision: string): Promise<string> {
		return this.exec(['escalations', 'resolve', id, '--decision', decision]);
	}

}
