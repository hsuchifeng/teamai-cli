/**
 * E2E (#1011): a `${VAR}` an MCP server references that no secrets file
 * declares and no env.yaml sets is the member's own token.
 *
 * The team repo has no `env/` at all and `mcp/mcp.yaml` names `tapd` with
 * `${TAPD_ACCESS_TOKEN}` in a header. Driven through the real CLI binary in a
 * sandbox HOME, as the issue reproduces it:
 *
 *   1. a pull from a shell that exports the token installs `tapd`;
 *   2. a pull that cannot see the export (the session-start hook's shell) used
 *      to delete the installed server — it now keeps the entry and says so;
 *   3. `teamai env set TAPD_ACCESS_TOKEN` accepts the key, stores the value in
 *      the member's own 0600 file, and the next pull resolves the server from
 *      it with no export at all; the token is written nowhere else.
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

const KEY = 'TAPD_ACCESS_TOKEN';
const EXPORTED = 'exported-token-1011';
const STORED = 'stored-token-1011';

interface RunResult {
  code: number | null;
  output: string;
}

let sandbox: string;
let home: string;
let cwd: string;

function git(args: string[], dir: string): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const fwd = (value: string): string => value.split(path.sep).join('/');

function runCLI(args: string[], extraEnv: Record<string, string | undefined> = {}, stdin = ''): Promise<RunResult> {
  // The member's own shell export is never inherited from this process.
  const env: Record<string, string | undefined> = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', [KEY]: undefined, ...extraEnv,
  };
  delete env.CLAUDE_CONFIG_DIR;
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

function cursorMcp(): Record<string, { headers?: Record<string, string> }> {
  const file = path.join(home, '.cursor', 'mcp.json');
  if (!fs.existsSync(file)) return {};
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { headers?: Record<string, string> }> }).mcpServers ?? {};
}

function secretsDir(): string {
  return path.join(home, '.teamai', 'secrets', 'teams');
}

describe.skipIf(process.platform === 'win32')('MCP ${VAR} as the member\'s own token (#1011)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-1011-e2e-')));
    home = path.join(sandbox, 'home');
    cwd = path.join(sandbox, 'cwd');
    const remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');
    const localPath = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    // Cursor is installed; the team declares no env at all.
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    fs.mkdirSync(path.join(seed, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: tapd-e2e',
      `repo: ${fwd(remote)}`,
      'provider: git',
      'sharing:',
      '  mcp:',
      '    autoApply: true',
      '  env:',
      '    injectShellProfile: false',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - name: tapd',
      '    transport: http',
      '    url: https://tapd.example.com/mcp',
      '    headers:',
      `      X-Tapd-Access-Token: \${${KEY}}`,
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
    git(['push', '-q', remote, 'main'], seed);
    git(['clone', '-q', remote, localPath], sandbox);

    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${fwd(localPath)}`,
      `  remote: ${fwd(remote)}`,
      '  kind: git',
      'username: alice',
      'scope: user',
      'enabledAgents: [cursor]',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('a pull that sees the shell export installs the server', async () => {
    const res = await runCLI(['pull', '--force'], { [KEY]: EXPORTED });
    expect(res.code, res.output).toBe(0);
    expect(cursorMcp().tapd?.headers?.['X-Tapd-Access-Token']).toBe(EXPORTED);
  }, 60_000);

  it('a pull that cannot see the export keeps the installed server and says so', async () => {
    const res = await runCLI(['pull']);
    expect(res.code, res.output).toBe(0);
    // The entry an earlier pull wrote stays as it is.
    expect(cursorMcp().tapd?.headers?.['X-Tapd-Access-Token'], res.output).toBe(EXPORTED);
    expect(res.output).toMatch(new RegExp(`tapd: ${KEY} is not set\\. Run \`teamai env set ${KEY}\``));
    expect(res.output).toMatch(/tapd: the entry an earlier pull wrote stays in cursor/);
  }, 60_000);

  it('env list shows the referenced variable as a team secret', async () => {
    const res = await runCLI(['env', 'list']);
    expect(res.code, res.output).toBe(0);
    expect(res.output).toContain('Team secrets (1):');
    expect(res.output).toMatch(new RegExp(`${KEY}\\s+missing`));
  });

  it('env set stores the member\'s value in their own 0600 file', async () => {
    const res = await runCLI(['env', 'set', KEY, '--stdin'], {}, `${STORED}\n`);
    expect(res.code, res.output).toBe(0);
    expect(res.output).toContain(`Set ${KEY} for this team`);

    const files = fs.readdirSync(secretsDir()).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const store = path.join(secretsDir(), files[0]);
    expect(fs.statSync(store).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(store, 'utf8')).toContain(STORED);
    // The value is in the member's store and nowhere else.
    expect(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).not.toContain(STORED);
  });

  it('the next pull resolves the server from the stored value with no export, and leaves the store alone', async () => {
    const files = fs.readdirSync(secretsDir()).filter((f) => f.endsWith('.json'));
    const store = path.join(secretsDir(), files[0]);
    const before = fs.readFileSync(store, 'utf8');
    const mtime = fs.statSync(store).mtimeMs;

    const res = await runCLI(['pull', '--force']);
    expect(res.code, res.output).toBe(0);
    expect(cursorMcp().tapd?.headers?.['X-Tapd-Access-Token'], res.output).toBe(STORED);
    expect(res.output).not.toContain('is not set');

    expect(fs.readFileSync(store, 'utf8')).toBe(before);
    expect(fs.statSync(store).mtimeMs).toBe(mtime);
    // The token appears in no log teamai writes.
    const debugLog = path.join(home, '.teamai', 'debug.log');
    if (fs.existsSync(debugLog)) expect(fs.readFileSync(debugLog, 'utf8')).not.toContain(STORED);
    expect(res.output).not.toContain(STORED);
  }, 60_000);
});
