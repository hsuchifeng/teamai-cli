import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── End-to-end: `teamai digest` output is English and names no member ──────
//
// A user-scope `git` provider team whose teamai-reports branch already holds
// two members' reported stats (skills, interventions, prompts, tokens). Runs
// the real CLI binary and checks the digest it prints:
//   - every label is English (no CJK characters anywhere in the output), and
//   - the autonomy / token sections report team-wide totals only — no
//     per-user ranking lines naming individual members.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

function runCLI(args: string[], homeDir: string, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', HOME: homeDir, USERPROFILE: homeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const fwd = (value: string): string => value.split(path.sep).join('/');

// Distinctive member names: a ranking line would have to print one of them.
const MEMBERS = ['alice-rankme', 'bob-rankme'] as const;

function reportedStats(username: string, uses: number, sessions: number, prompts: number, tokens: number): string {
  return [
    `username: ${username}`,
    'updatedAt: 2026-06-01T00:00:00Z',
    'skills:',
    '  deploy-helper:',
    `    count: ${uses}`,
    '    lastUsed: 2026-06-01T00:00:00Z',
    'interventions:',
    `  sessions: ${sessions}`,
    `  interrupt: ${sessions}`,
    '  toolReject: 1',
    '  correction: 2',
    `prompts: ${prompts}`,
    'tokens:',
    `  input: ${tokens}`,
    `  output: ${tokens}`,
    '  cacheRead: 0',
    '  cacheCreation: 0',
    '',
  ].join('\n');
}

describe('digest output e2e', () => {
  let sandbox: string;
  let homeDir: string;
  let cwd: string;
  let digest: { code: number | null; output: string };

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-digest-e2e-'));
    homeDir = path.join(sandbox, 'home');
    cwd = path.join(sandbox, 'cwd');
    const remote = path.join(sandbox, 'remote.git');
    const work = path.join(sandbox, 'work');
    const localPath = path.join(homeDir, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(homeDir, '.teamai'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    // main: teamai.yaml only.
    git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
    fs.mkdirSync(work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    fs.writeFileSync(path.join(work, 'teamai.yaml'), [
      'team: digest-e2e', `repo: ${fwd(remote)}`, 'provider: git', '',
    ].join('\n'));
    git(['add', '-A'], work);
    git(['commit', '-qm', 'team'], work);
    git(['remote', 'add', 'origin', remote], work);
    git(['push', '-q', 'origin', 'main'], work);

    // teamai-reports: two members' reported stats.
    git(['checkout', '-q', '--orphan', 'teamai-reports'], work);
    git(['rm', '-rq', '--cached', '.'], work);
    fs.rmSync(path.join(work, 'teamai.yaml'));
    fs.mkdirSync(path.join(work, 'stats'), { recursive: true });
    fs.writeFileSync(path.join(work, 'stats', `${MEMBERS[0]}.yaml`), reportedStats(MEMBERS[0], 3, 10, 40, 1000));
    fs.writeFileSync(path.join(work, 'stats', `${MEMBERS[1]}.yaml`), reportedStats(MEMBERS[1], 5, 4, 90, 5000));
    git(['add', '-A'], work);
    git(['commit', '-qm', 'reports'], work);
    git(['push', '-q', 'origin', 'teamai-reports'], work);

    git(['clone', '-q', remote, localPath], sandbox);
    fs.writeFileSync(path.join(homeDir, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${fwd(localPath)}`,
      `  remote: ${fwd(remote)}`,
      '  kind: git',
      `username: ${MEMBERS[0]}`,
      'scope: user',
      '',
    ].join('\n'));

    digest = await runCLI(['digest'], homeDir, cwd);
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('prints the team digest from the reported stats', () => {
    expect(digest.code, digest.output).toBe(0);
    expect(digest.output).toContain('Team AI Weekly Digest');
    expect(digest.output).toContain('Active members: 2');
    expect(digest.output).toContain('deploy-helper (8 uses)');
  });

  it('labels every section in English', () => {
    // No CJK characters anywhere in the output.
    expect(digest.output).not.toMatch(/[㐀-鿿]/);
    expect(digest.output).toContain('Session Autonomy (Human Intervention):');
    expect(digest.output).toContain('Team avg: 1.43 interventions/session (14 sessions, 20 interventions)');
    expect(digest.output).toContain('Breakdown: interrupt 14 · reject 2 · correction 4');
    expect(digest.output).toContain('Lifetime Conversation & Token Usage:');
    expect(digest.output).toContain('Lifetime human prompts: 130');
    expect(digest.output).toContain('Lifetime tokens: 12.0K (input 6.0K · output 6.0K · cache read 0 · cache write 0)');
  });

  it('reports team-wide totals only, never a per-user ranking', () => {
    for (const member of MEMBERS) expect(digest.output).not.toContain(member);
    expect(digest.output).not.toMatch(/rank/i);
  });
});
