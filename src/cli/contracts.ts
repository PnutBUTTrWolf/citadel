/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Type-safe contracts for CLI output.  Provides interfaces for every
 * CLI response shape and lightweight validation helpers.
 */

// ---------------------------------------------------------------------------
// gt status --json
// ---------------------------------------------------------------------------

export interface GtOverseer {
	name: string;
	email: string;
	username: string;
	source: string;
	unread_mail: number;
}

export interface GtHookInfo {
	agent: string;
	role: string;
	has_work: boolean;
}

export interface GtAgentSummary {
	name: string;
	address: string;
	session: string;
	role: string;
	running: boolean;
	has_work: boolean;
	state?: string;
	unread_mail: number;
	first_subject?: string;
}

export interface GtRigInfo {
	name: string;
	polecats: string[];
	polecat_count: number;
	crews: string[] | null;
	crew_count: number;
	has_witness: boolean;
	has_refinery: boolean;
	hooks: GtHookInfo[];
	agents: GtAgentSummary[];
}

export interface GtStatusSummary {
	rig_count: number;
	polecat_count: number;
	crew_count: number;
	witness_count: number;
	refinery_count: number;
	active_agents: number;
}

export interface GtStatus {
	name: string;
	location: string;
	overseer: GtOverseer;
	agents: GtAgentSummary[];
	rigs: GtRigInfo[];
	summary?: GtStatusSummary;
}

// ---------------------------------------------------------------------------
// bd list --json / bd show --json
// ---------------------------------------------------------------------------

export type BdBeadStorageStatus = 'open' | 'closed';

export interface BdBead {
	id: string;
	title: string;
	description: string;
	status: BdBeadStorageStatus;
	priority: number;
	issue_type: string;
	assignee?: string | null;
	created_at: string;
	created_by: string;
	updated_at: string;
	labels: string[];
	ephemeral: boolean;
	parent_id?: string | null;
	children?: string[];
	hook_bead?: boolean;
	blocked_by_count?: number;
}

// ---------------------------------------------------------------------------
// gt convoy list --json
// ---------------------------------------------------------------------------

export type GtConvoyWorkStatus = 'complete' | 'active' | 'stale' | 'stuck' | 'waiting';
export type GtConvoyStatus = 'open' | 'closed';

export interface GtTrackedIssue {
	id: string;
	title: string;
	status: string;
	assignee?: string | null;
	priority: number;
}

export interface GtConvoyContract {
	id: string;
	title: string;
	description?: string;
	status: GtConvoyStatus;
	work_status: GtConvoyWorkStatus;
	progress: string;
	completed: number;
	total: number;
	created_at: string;
	updated_at: string;
	tracked_issues: GtTrackedIssue[];
}

// ---------------------------------------------------------------------------
// gt mail inbox --json
// ---------------------------------------------------------------------------

export type GtMailPriority = 'low' | 'normal' | 'high' | 'urgent';
export type GtMailType = 'task' | 'scavenge' | 'notification' | 'reply';

export interface GtMailMessage {
	id: string;
	from: string;
	to: string;
	subject: string;
	body: string;
	timestamp: string;
	read: boolean;
	priority: GtMailPriority;
	type: GtMailType;
	delivery_state?: string;
	thread_id?: string | null;
	reply_to?: string | null;
}

// ---------------------------------------------------------------------------
// gt mq list --json  (merge queue)
// ---------------------------------------------------------------------------

export type MergeQueueItemStatus = 'waiting' | 'merging' | 'blocked' | 'failed' | 'merged';

export interface GtMergeQueueItem {
	id: string;
	rig: string;
	branch: string;
	agent?: string;
	bead_id?: string;
	status: MergeQueueItemStatus;
	position: number;
	pr_url?: string;
	title?: string;
	created_at: string;
}

// ---------------------------------------------------------------------------
// Activity feed (.events.jsonl)
// ---------------------------------------------------------------------------

export type ActivityCategory = 'agent' | 'work' | 'comms' | 'system';

export interface ActivityEvent {
	ts: string;
	source: string;
	type: string;
	actor: string;
	payload: Record<string, unknown>;
	visibility?: string;
	category: ActivityCategory;
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export type EscalationType = 'decision' | 'conflict' | 'failure';
export type EscalationSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface GtEscalation {
	id: string;
	type: EscalationType;
	severity: EscalationSeverity;
	title: string;
	description: string;
	agent?: string;
	rig?: string;
	bead_id?: string;
	created_at: string;
	resolved: boolean;
	resolution?: string;
}

// ---------------------------------------------------------------------------
// Health / Watchdog
// ---------------------------------------------------------------------------

export type WatchdogTier = 'daemon' | 'boot' | 'deacon' | 'dolt';
export type TierHealth = 'healthy' | 'degraded' | 'down';

export interface GtWatchdogTierStatus {
	tier: WatchdogTier;
	health: TierHealth;
	pid?: number;
	uptime?: string;
	last_heartbeat?: string;
	message?: string;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface CapabilitiesResult {
	gtVersion: string | null;
	bdVersion: string | null;
	features: {
		jsonOutput: boolean;
		mail: boolean;
		work: boolean;
		convoys: boolean;
	};
	available: boolean;
	error: string | null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> =
	| { success: true; data: T }
	| { success: false; error: string };

/**
 * Safely parse JSON CLI output.  Returns structured result without throwing.
 */
export function parseCliOutput<T>(jsonString: string): ParseResult<T> {
	try {
		const data = JSON.parse(jsonString) as T;
		return { success: true, data };
	} catch (e) {
		return { success: false, error: `JSON parse error: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/**
 * Parse CLI output or throw on failure.
 */
export function parseCliOutputOrThrow<T>(jsonString: string): T {
	const result = parseCliOutput<T>(jsonString);
	if (!result.success) {
		throw new Error(result.error);
	}
	return result.data;
}

/**
 * Safely extract an array from CLI output, returning [] on any failure.
 */
export function parseCliArray<T>(jsonString: string): T[] {
	const result = parseCliOutput<T[]>(jsonString);
	if (result.success && Array.isArray(result.data)) {
		return result.data;
	}
	return [];
}
