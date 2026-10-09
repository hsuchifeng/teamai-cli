/**
 * Team-defined post-init script (`scripts.postInit` in teamai.yaml, #1012).
 *
 * `scripts.postPull` runs headless at the end of every pull, so it cannot ask
 * the member anything. A team whose MCP servers need a personal token has no
 * step a new member sees: `teamai init` ends and the token is still unset.
 * `postInit` is that step: a Node entrypoint `teamai init` runs once, with the
 * terminal attached, after the local config and hooks are in place and before
 * the closing pull delivers MCP, so the values it collects (say, through
 * `teamai env set`) land in that same pull. `teamai script run postInit` runs
 * it again for a member who already initialized.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { loadTeamConfig } from './config.js';
import { log } from './utils/logger.js';
import { assertSafePath } from './utils/path-safety.js';
import { isInteractive } from './utils/prompt.js';
import type { LocalConfig } from './types.js';

/** The command that runs the script again. */
export const RUN_POST_INIT = 'teamai script run postInit';

/** What `runDeclaredPostInit` did: the exit code when the script ran. */
export type PostInitOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'ran'; readonly code: number | null };

/**
 * Run the team's post-init script for this scope, if it declares one. Never
 * throws: a bad path, a missing file or a failed run is a warning with the
 * command that runs it again, never a failed init.
 *
 * Without `explicit`, the script is skipped when nobody can answer it
 * (`isInteractive`: no TTY, `CI`, `TEAMAI_NONINTERACTIVE`), with the command
 * to run later. `teamai script run postInit` passes `explicit` and always runs.
 */
export async function runDeclaredPostInit(
  localConfig: LocalConfig,
  { explicit = false }: { explicit?: boolean } = {},
): Promise<PostInitOutcome> {
  const repoPath = localConfig.repo.localPath;
  const teamConfig = await loadTeamConfig(repoPath);
  const declared = teamConfig?.scripts?.postInit?.path;
  if (!declared) return { kind: 'none' };
  const scriptPath = path.resolve(repoPath, declared);
  if (!fs.existsSync(scriptPath)) {
    log.warn(`Team setup script ${declared} is declared in teamai.yaml but not in the team repo; it was not run.`);
    return { kind: 'none' };
  }
  // This script runs on every member's machine: the repo must not be able to
  // point it outside its own clone, symlinks included.
  try {
    assertSafePath(scriptPath, [repoPath]);
  } catch (e) {
    log.warn(`Team setup script ${declared} was not run: ${(e as Error).message}`);
    return { kind: 'none' };
  }
  if (!explicit && !isInteractive()) {
    log.info(`Team setup script ${declared} needs a terminal and was not run. Run it later with \`${RUN_POST_INIT}\`.`);
    return { kind: 'skipped' };
  }

  log.info(`Running the team setup script ${declared}...`);
  const code = await runScript(scriptPath, repoPath, localConfig.scope);
  if (code === 0) {
    log.success(`Team setup script ${declared} finished.`);
  } else {
    log.warn(`Team setup script ${declared} exited ${code ?? 'without a code'}. Run it again with \`${RUN_POST_INIT}\`.`);
  }
  return { kind: 'ran', code };
}

/**
 * Run the script under our node with the terminal attached and no time limit:
 * it may prompt, and only the member can say when they are done.
 */
function runScript(scriptPath: string, repoPath: string, scope: LocalConfig['scope']): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: repoPath,
      stdio: 'inherit',
      env: { ...process.env, TEAMAI_REPO: repoPath, TEAMAI_SCOPE: scope },
    });
    child.on('error', (e) => {
      log.warn(`Team setup script could not be started: ${e.message}`);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
}
