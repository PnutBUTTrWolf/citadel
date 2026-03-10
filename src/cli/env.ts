/*---------------------------------------------------------------------------------------------
 *  VSMax - Citadel Terminal IDE
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ADDITIONAL_BIN_DIRS = [
	path.join(os.homedir(), '.local', 'bin'),
	path.join(os.homedir(), 'go', 'bin'),
	'/opt/homebrew/bin',
	'/usr/local/bin',
];

/**
 * Return a copy of `process.env` with common user-local binary directories
 * prepended to PATH.  VS Code's extension host often inherits a minimal PATH
 * (e.g. when launched from Finder/Spotlight) that doesn't include directories
 * like `~/.local/bin` where `gt` is typically installed.
 */
export function getEnvWithPath(): NodeJS.ProcessEnv {
	const currentPath = process.env['PATH'] || '';
	const newPath = [...ADDITIONAL_BIN_DIRS, currentPath].join(':');
	return { ...process.env, PATH: newPath };
}

/**
 * Build the full PATH string (enriched with user-local bin dirs).
 * Useful for searching without constructing a full env copy.
 */
function getEnrichedPath(): string {
	const currentPath = process.env['PATH'] || '';
	return [...ADDITIONAL_BIN_DIRS, currentPath].join(':');
}

/**
 * Resolve a bare command name (e.g. `"gt"`) to an absolute path by walking
 * the enriched PATH.  If the input is already absolute it's returned as-is.
 * Returns the original command unchanged if no match is found, so spawn will
 * still produce a meaningful ENOENT that names the binary.
 */
export function resolveCommand(command: string): string {
	if (path.isAbsolute(command)) {
		return command;
	}

	for (const dir of getEnrichedPath().split(':')) {
		if (!dir) {
			continue;
		}
		const candidate = path.join(dir, command);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// not found / not executable — keep searching
		}
	}

	return command;
}
