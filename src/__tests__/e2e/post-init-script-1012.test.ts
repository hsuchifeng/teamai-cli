/**
 * E2E (#1012): `scripts.postInit` in teamai.yaml, the interactive team setup
 * script `teamai init` runs with the terminal attached.
 *
 * The team declares a secret (`SETUP_TOKEN`) an MCP server needs and a setup
 * script that asks for it and stores it with `teamai env set`. Driven through
 * the real CLI binary against a bare `git` provider remote in a sandbox HOME:
 *
 *   1. `teamai init` without a terminal finishes, skips the script and names
 *      `teamai script run postInit`;
 *   2. `teamai script run postInit` runs the script, which reads the member's
 *      answer, sees TEAMAI_REPO / TEAMAI_SCOPE, and stores the token; the MCP
 *      sync that follows writes the resolved value into the tool's config;
 *   3. a script path that resolves outside the team repo is rejected;
 *   4. a failing script makes `script run` exit with its code, with no MCP sync.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

const ANSWER = 'token-from-the-member-1012';
/** `init` wants a real repo URL; git's `insteadOf` in the sandbox HOME rewrites it to the bare remote. */
const FAKE_URL = (name: string): string => `https://git.example.com/team/${name}.git`;

interface RunResult {
  code: number | null;
  output: string;
}

let sandbox: string;

function git(args: string[], dir: string): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

function runCLI(args: string[], home: string, cwd: string, extraEnv: Record<string, string> = {}, stdin?: string): Promise<RunResult> {
  const env: Record<string, string | undefined> = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', GIT_CONFIG_NOSYSTEM: '1', ...extraEnv,
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CI;
  delete env.TEAMAI_NONINTERACTIVE;
  return new Promise((resolve) => {
    // stdin is a pipe, never a terminal: init must not wait on anyone.
    const child = spawn('node', [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** The setup script the team ships: asks for the token and stores it with `teamai env set`. */
const SETUP_SCRIPT = `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const token = await new Promise((resolve) => rl.question('SETUP_TOKEN: ', resolve));
rl.close();
fs.writeFileSync(process.env.SETUP_RECORD, JSON.stringify({
  token, repo: process.env.TEAMAI_REPO, scope: process.env.TEAMAI_SCOPE, cwd: process.cwd(),
}));
const set = spawnSync(process.execPath, [process.env.TEAMAI_CLI, 'env', 'set', 'SETUP_TOKEN', '--stdin'], {
  input: token + '\\n', stdio: ['pipe', 'inherit', 'inherit'],
});
process.exit(set.status ?? 1);
`;

/** A team repo on a bare remote: teamai.yaml with `scripts.postInit`, a declared secret, an MCP server that needs it. */
function makeTeam(name: string, script: { path: string; body?: string }): { remote: string } {
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  // A retried test starts over.
  fs.rmSync(seed, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
  fs.mkdirSync(path.join(seed, 'env'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`,
    `repo: ${FAKE_URL(name)}`,
    'provider: git',
    'sharing:',
    '  mcp:',
    '    autoApply: true',
    '  env:',
    '    injectShellProfile: false',
    'scripts:',
    '  postInit:',
    `    path: ${script.path}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(seed, 'env', 'secrets.yaml'), 'secrets:\n  - key: SETUP_TOKEN\n    description: Setup token fixture\n');
  fs.writeFileSync(path.join(seed, 'mcp', 'mcp.yaml'), [
    'servers:',
    '  - name: setup-api',
    '    transport: http',
    '    url: https://setup.example.com/mcp',
    '    headers:',
    '      X-Setup-Token: ${SETUP_TOKEN}',
    '',
  ].join('\n'));
  if (script.body !== undefined) {
    const file = path.join(seed, script.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, script.body);
  }
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
  git(['push', '-q', remote, 'main'], seed);
  return { remote };
}

function makeHome(name: string, remote: string): string {
  const home = path.join(sandbox, `home-${name}`);
  fs.rmSync(home, { recursive: true, force: true });
  // Cursor is installed on this machine.
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  execFileSync('git', ['config', '--global', `url.${remote}.insteadOf`, FAKE_URL(name)], {
    cwd: sandbox, stdio: 'pipe', env: { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home },
  });
  return home;
}

function cursorHeader(home: string): string | undefined {
  const file = path.join(home, '.cursor', 'mcp.json');
  if (!fs.existsSync(file)) return undefined;
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { headers?: Record<string, string> }> };
  return json.mcpServers?.['setup-api']?.headers?.['X-Setup-Token'];
}

describe.skipIf(process.platform === 'win32')('scripts.postInit (#1012)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-1012-e2e-')));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('init without a terminal skips the script, names how to run it, and script run then collects the token', async () => {
    const { remote } = makeTeam('setup', { path: 'scripts/setup-env.mjs', body: SETUP_SCRIPT });
    const home = makeHome('setup', remote);
    const cwd = path.join(sandbox, 'setup-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const record = path.join(sandbox, 'setup-record.json');
    const env = { SETUP_RECORD: record, TEAMAI_CLI: CLI };

    // 1. init: no terminal, so the script is skipped and init still finishes.
    const init = await runCLI(['init', FAKE_URL('setup'), '--provider', 'git', '--scope', 'user', '--agent', 'cursor', '--force'], home, cwd, env);
    expect(init.code, init.output).toBe(0);
    expect(init.output).toMatch(/teamai initialized successfully/);
    expect(init.output).toContain('Team setup script scripts/setup-env.mjs needs a terminal and was not run. Run it later with `teamai script run postInit`.');
    expect(fs.existsSync(record)).toBe(false);
    // The server waits for its token.
    expect(cursorHeader(home)).toBeUndefined();
    expect(init.output).toMatch(/setup-api: SETUP_TOKEN is not set\. Run `teamai env set SETUP_TOKEN`/);

    // 2. script run: the script reads the member's answer and stores the token; MCP is synced after it.
    const run = await runCLI(['script', 'run', 'postInit'], home, cwd, env, `${ANSWER}\n`);
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('Running the team setup script scripts/setup-env.mjs');
    expect(run.output).toContain('SETUP_TOKEN: ');
    expect(run.output).toContain('Set SETUP_TOKEN for this team');
    expect(run.output).toContain('Team setup script scripts/setup-env.mjs finished.');
    expect(run.output).toContain('MCP inject:');
    const recorded = JSON.parse(fs.readFileSync(record, 'utf8')) as { token: string; repo: string; scope: string; cwd: string };
    const localPath = path.join(home, '.teamai', 'team-repo');
    expect(recorded).toEqual({ token: ANSWER, repo: localPath, scope: 'user', cwd: localPath });
    expect(cursorHeader(home), run.output).toBe(ANSWER);
    // The token went to the member's store, not into the output.
    expect(run.output).not.toContain(ANSWER);
  }, 120_000);

  it('rejects a script path that resolves outside the team repo', async () => {
    const { remote } = makeTeam('escape', { path: '../outside.mjs' });
    fs.writeFileSync(path.join(sandbox, 'outside.mjs'), 'process.exit(0);\n');
    const home = makeHome('escape', remote);
    const cwd = path.join(sandbox, 'escape-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    // The clone lands at <home>/.teamai/team-repo, so ../outside.mjs is <home>/.teamai/outside.mjs.
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'outside.mjs'), 'process.exit(0);\n');

    const init = await runCLI(['init', FAKE_URL('escape'), '--provider', 'git', '--scope', 'user', '--agent', 'cursor', '--force'], home, cwd);
    expect(init.code, init.output).toBe(0);
    const run = await runCLI(['script', 'run', 'postInit'], home, cwd, {}, '\n');
    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/Team setup script \.\.\/outside\.mjs was not run: .*outside/);
    expect(run.output).not.toContain('Running the team setup script');
  }, 120_000);

  it('a failing script makes script run exit with its code and skips the MCP sync', async () => {
    const { remote } = makeTeam('failing', { path: 'scripts/fail.mjs', body: 'console.log("setup failed on purpose");\nprocess.exit(3);\n' });
    const home = makeHome('failing', remote);
    const cwd = path.join(sandbox, 'failing-cwd');
    fs.mkdirSync(cwd, { recursive: true });

    const init = await runCLI(['init', FAKE_URL('failing'), '--provider', 'git', '--scope', 'user', '--agent', 'cursor', '--force'], home, cwd);
    expect(init.code, init.output).toBe(0);
    const run = await runCLI(['script', 'run', 'postInit'], home, cwd, {}, '');
    expect(run.code, run.output).toBe(3);
    expect(run.output).toContain('setup failed on purpose');
    expect(run.output).toContain('Team setup script scripts/fail.mjs exited 3. Run it again with `teamai script run postInit`.');
    expect(run.output).not.toContain('MCP inject:');
  }, 120_000);
});
