import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── End-to-end: project-scope usage reaches the project team repo ──────────
//
// A project-only install (no user-scope config at all) whose team repo is a
// plain `git` provider remote. Drives the real CLI binary the way the hooks
// and the member do:
//
//   PostToolUse hook ──▶ teamai track --stdin   (skill usage recorded)
//                              │
//                              ▼
//                         teamai pull           (usage reported to the
//                              │                 project team repo)
//                              ▼
//      teamai digest / teamai stats             (project data shows up)
//
// Usage used to be reported only to the user-scope team repo, so a project
// with its own team repo never received stats and `teamai digest` run inside
// it always printed "No team usage data available yet."

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const USERNAME = 'ci-proj';
const SKILL = 'demo-skill';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], homeDir: string, cwd: string, stdin = ''): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', HOME: homeDir, USERPROFILE: homeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output: out }));
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

const fwd = (value: string): string => value.split(path.sep).join('/');

describe('project-scope usage reporting e2e', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;
  let remote: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-proj-usage-e2e-'));
    homeDir = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'proj');
    remote = path.join(sandbox, 'proj-remote.git');
    // A project-only install: HOME has no ~/.teamai/config.yaml.
    fs.mkdirSync(homeDir, { recursive: true });
    // The deploy "is tool installed" gate for the project scope.
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });

    // Team repo on a bare `git` provider remote: teamai.yaml + one skill.
    git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
    const work = path.join(sandbox, 'work');
    fs.mkdirSync(path.join(work, 'skills', SKILL), { recursive: true });
    fs.writeFileSync(path.join(work, 'teamai.yaml'), [
      'team: proj-usage-e2e',
      `repo: ${fwd(remote)}`,
      'provider: git',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '',
    ].join('\n'));
    fs.writeFileSync(
      path.join(work, 'skills', SKILL, 'SKILL.md'),
      `---\nname: ${SKILL}\ndescription: demo skill for e2e\n---\n\n# ${SKILL}\n\nDemo.\n`,
    );
    git(['init', '-q', '-b', 'main'], work);
    git(['add', '-A'], work);
    git(['commit', '-qm', 'team'], work);
    git(['remote', 'add', 'origin', remote], work);
    git(['push', '-q', 'origin', 'main'], work);

    const projectLocal = path.join(projectRoot, '.teamai', 'team-repo');
    git(['clone', '-q', remote, projectLocal], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${fwd(projectLocal)}`,
      `  remote: ${fwd(remote)}`,
      '  kind: git',
      `username: ${USERNAME}`,
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${fwd(projectRoot)}`,
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('digest reports no data before anything is reported', async () => {
    const res = await runCLI(['digest'], homeDir, projectRoot);
    expect(res.code, res.output).toBe(0);
    expect(res.output).toContain('No team usage data available yet.');
  });

  it('track --stdin records a skill use for the project scope', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'proj-usage-e2e-1',
      cwd: projectRoot,
      tool_name: 'Skill',
      tool_input: { skill: SKILL },
    });
    const res = await runCLI(['track', '--stdin', '--tool', 'claude'], homeDir, projectRoot, payload);
    expect(res.code, res.output).toBe(0);

    const stats = await runCLI(['stats'], homeDir, projectRoot);
    expect(stats.code, stats.output).toBe(0);
    expect(stats.output).toContain(SKILL);
    expect(stats.output).toContain('1 pending upload');
  });

  it('pull reports the usage to the project team repo', async () => {
    const res = await runCLI(['pull'], homeDir, projectRoot);
    expect(res.code, res.output).toBe(0);

    // The stats landed on the remote's teamai-reports branch under this member's name.
    const branches = git(['branch', '--list', 'teamai-reports'], remote);
    expect(branches, res.output).toContain('teamai-reports');
    const statsYaml = git(['show', `teamai-reports:stats/${USERNAME}.yaml`], remote);
    expect(statsYaml).toContain(`username: ${USERNAME}`);
    expect(statsYaml).toMatch(new RegExp(`${SKILL}:\\s*\\n\\s*count: 1`));
  }, 60_000);

  it('digest shows the project team data after the report', async () => {
    const res = await runCLI(['digest'], homeDir, projectRoot);
    expect(res.code, res.output).toBe(0);
    expect(res.output).not.toContain('No team usage data available yet.');
    expect(res.output).toContain('Active members: 1');
    expect(res.output).toContain('Most Used Skills:');
    expect(res.output).toContain(`${SKILL} (1 uses)`);
  });

  it('stats reads the reported totals and nothing is left pending', async () => {
    const res = await runCLI(['stats'], homeDir, projectRoot);
    expect(res.code, res.output).toBe(0);
    expect(res.output).toMatch(new RegExp(`${SKILL}\\s+1 uses`));
    expect(res.output).not.toContain('pending upload');
  });
});
