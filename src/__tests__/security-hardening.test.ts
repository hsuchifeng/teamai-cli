import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(), execFileSync: vi.fn() };
});

import { spawn, execFileSync } from 'node:child_process';
import matter from '../utils/safe-matter.js';
import { splitFrontmatter } from '../utils/frontmatter.js';
import { log } from '../utils/logger.js';
import { shallowClone } from '../clone.js';
import { fetchGitHubPR } from '../providers/github/mr-fetch.js';
import { ensureSkillFrontmatter } from '../resources/skills.js';

function makeSilentProcess(): ChildProcess {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') void Promise.resolve().then(() => cb(0));
    }),
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

describe('front matter never runs JavaScript', () => {
  it('refuses a ---js block instead of evaluating it', () => {
    expect(() => matter('---js\n{ pwned: process.pid }\n---\nbody\n')).toThrow(/not allowed/);
    expect(() => matter('---javascript\n{ pwned: 1 }\n---\n')).toThrow(/not allowed/);
  });

  it('still parses YAML front matter and round-trips through stringify', () => {
    const parsed = matter('---\nname: demo\ntags: [a, b]\n---\nhello\n');
    expect(parsed.data).toEqual({ name: 'demo', tags: ['a', 'b'] });
    expect(parsed.content.trim()).toBe('hello');
    expect(matter.stringify('hello', { name: 'demo' })).toContain('name: demo');
  });

  it('splitFrontmatter ignores a ---js fence', () => {
    const split = splitFrontmatter('---js\n{ pwned: 1 }\n---\nbody\n');
    expect(split.data).toEqual({});
  });
});

describe('fetchGitHubPR passes the URL parts to gh without a shell', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('rejects a URL whose owner carries shell metacharacters', async () => {
    await expect(fetchGitHubPR('https://github.com/x/a;id/pull/1')).rejects.toThrow(/Invalid GitHub PR URL/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('calls gh with an argv, not a command string', async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(JSON.stringify({ title: 't', body: 'b', author: { login: 'me' }, mergedAt: null, commits: [] }))
      .mockReturnValueOnce('diff');
    const data = await fetchGitHubPR('https://github.com/owner/repo.name/pull/42?foo=bar');
    expect(data.title).toBe('t');
    expect(vi.mocked(execFileSync).mock.calls[0]?.[0]).toBe('gh');
    expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toEqual([
      'pr', 'view', '42', '--repo', 'owner/repo.name', '--json', 'title,body,author,mergedAt,commits',
    ]);
  });
});

describe('shallowClone keeps the URL out of git option parsing', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sec-clone-'));
    vi.spyOn(log, 'debug').mockImplementation(() => {});
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => makeSilentProcess());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('places `--` before the clone URL', async () => {
    await shallowClone('https://example.com/org/repo.git', path.join(tmp, 'repo'), 'git');
    const cloneCall = vi.mocked(spawn).mock.calls.find((c) => (c[1] as string[]).includes('clone'));
    const args = cloneCall?.[1] as string[];
    expect(args.indexOf('--')).toBeGreaterThan(args.indexOf('clone'));
    expect(args[args.indexOf('--') + 1]).toBe('https://example.com/org/repo.git');
  });

  it('refuses a URL that would be read as a git option', async () => {
    await expect(
      shallowClone('--upload-pack=touch /tmp/pwned@evil.host:a/b', path.join(tmp, 'repo'), 'git'),
    ).rejects.toThrow(/Invalid repository URL/);
    expect(vi.mocked(spawn).mock.calls.some((c) => (c[1] as string[]).includes('clone'))).toBe(false);
  });
});

describe('ensureSkillFrontmatter does not write through a symlinked SKILL.md', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sec-skill-'));
    vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('leaves the link target untouched', async () => {
    const target = path.join(tmp, 'victim.txt');
    fs.writeFileSync(target, 'precious\n');
    const skillDir = path.join(tmp, 'skill');
    fs.mkdirSync(skillDir);
    fs.symlinkSync(target, path.join(skillDir, 'SKILL.md'));

    expect(await ensureSkillFrontmatter(skillDir, 'skill')).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('precious\n');
  });
});
