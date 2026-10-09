/**
 * `teamai script run <name>`: run a script the team declares in teamai.yaml
 * for the scope that governs this directory. Only `postInit` for now (#1012):
 * the setup script `teamai init` runs with the terminal attached, for a member
 * who already initialized, followed by the MCP sync init would have done.
 */
import { autoDetectInit } from './config.js';
import { log } from './utils/logger.js';
import { runDeclaredPostInit } from './post-init.js';
import type { GlobalOptions } from './types.js';

const SCRIPTS = ['postInit'] as const;

export async function scriptRun(name: string, options: GlobalOptions): Promise<void> {
  if (!(SCRIPTS as readonly string[]).includes(name)) {
    log.error(`Unknown team script "${name}". Scripts that can be run: ${SCRIPTS.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  if (!teamConfig.scripts?.postInit) {
    log.info('This team declares no postInit script (teamai.yaml `scripts.postInit`).');
    return;
  }
  if (options.dryRun) {
    log.info(`[dry-run] Would run ${teamConfig.scripts.postInit.path} from ${localConfig.repo.localPath}, then sync MCP servers.`);
    return;
  }
  const outcome = await runDeclaredPostInit(localConfig, { explicit: true });
  if (outcome.kind !== 'ran') return;
  if (outcome.code !== 0) {
    process.exitCode = outcome.code ?? 1;
    return;
  }
  // The values the script collected reach the tools now, as after init.
  const { mcpInject } = await import('./mcp-cmd.js');
  await mcpInject({ verbose: options.verbose });
}
