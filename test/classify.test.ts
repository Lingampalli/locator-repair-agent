import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectSignature, classifyOne, group, cascadeGuard } from '../src/classify.js';
import { LocatorIndex } from '../src/locator.js';
import { ConfigSchema, type Config } from '../src/config.js';
import type { ClassifiedFailure, FailureRecord, LocatorDefinition } from '../src/types.js';

const DOM = `<!doctype html><html><body>
  <main>
    <button id="login-submit-btn" type="submit">Sign In</button>
    <a href="/help" class="nav-item">Help Desk</a>
    <a href="/roles" class="nav-item">Role Request</a>
  </main>
</body></html>`;

let dir: string;
let cfg: Config;

async function writeArtifacts(name: string, dom: string, har?: string): Promise<string> {
  const d = path.join(dir, name);
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, 'dom.html'), dom, 'utf8');
  if (har) await writeFile(path.join(d, 'network.har'), har, 'utf8');
  return d;
}

function record(over: Partial<FailureRecord> & { artifactDir: string }): FailureRecord {
  return {
    tag: '@login',
    buildNumber: '100',
    featureFile: 'features/login.feature',
    featureName: 'Login',
    scenarioName: 'user signs in',
    scenarioLine: 12,
    failingStepText: 'When I click the "Sign In" button',
    errorMessage: '',
    artifacts: { dom: path.join(over.artifactDir, 'dom.html') },
    ...over,
  };
}

const DEFS: LocatorDefinition[] = [
  {
    filePath: '/repo/src/pages/LoginPage.ts',
    symbol: 'submitButton',
    expression: "page.locator('#btn-submit-login')",
    builder: 'locator',
    selectorValue: '#btn-submit-login',
    line: 10,
  },
  {
    filePath: '/repo/src/pages/LoginPage.ts',
    symbol: 'presentButton',
    expression: "page.locator('#login-submit-btn')",
    builder: 'locator',
    selectorValue: '#login-submit-btn',
    line: 14,
  },
  {
    filePath: '/repo/src/pages/PortalHeader.ts',
    symbol: 'navItem',
    expression: "page.locator('.nav-item')",
    builder: 'locator',
    selectorValue: '.nav-item',
    line: 8,
  },
  {
    filePath: '/repo/src/pages/HelpDeskPage.ts',
    symbol: 'searchBox',
    expression: "page.getByRole('textbox', { name: 'Search requests' })",
    builder: 'getByRole',
    selectorValue: 'Search requests',
    role: 'textbox',
    line: 6,
  },
];

const index = LocatorIndex.fromDefinitions(DEFS);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lra-'));
  cfg = ConfigSchema.parse({});
});

describe('detectSignature', () => {
  it.each([
    ['strict mode violation: locator(\'.x\') resolved to 3 elements:', 'strict_mode'],
    ['TimeoutError: locator.click: Timeout 30000ms exceeded.\nwaiting for locator(\'#x\')', 'locator_timeout'],
    ['Error: element is not attached to the DOM', 'detached'],
    ['Target page, context or browser has been closed', 'target_closed'],
    ["AssertionError: expected null to equal 'Sign In'", 'assertion'],
    ['something entirely different', 'unknown'],
  ])('classifies %s', (message, expected) => {
    expect(detectSignature(message)).toBe(expected);
  });
});

describe('classifyOne', () => {
  it('marks a broken locator fixable when an equivalent element remains', async () => {
    const artifactDir = await writeArtifacts('fixable', DOM);
    const c = await classifyOne(
      cfg,
      record({
        artifactDir,
        errorMessage:
          "TimeoutError: locator.click: Timeout 30000ms exceeded.\nwaiting for locator('#btn-submit-login')",
      }),
      index,
    );
    expect(c.verdict).toBe('fixable');
    expect(c.definition?.symbol).toBe('submitButton');
  });

  it('calls it a regression when no equivalent element exists', async () => {
    const artifactDir = await writeArtifacts('regression', DOM);
    const c = await classifyOne(
      cfg,
      record({
        artifactDir,
        tag: '@helpdesk',
        errorMessage:
          "TimeoutError: waiting for getByRole('textbox', { name: 'Search requests' })",
      }),
      index,
    );
    expect(c.verdict).toBe('regression');
  });

  it('treats a resolving locator with a wrong value as a real test failure', async () => {
    const artifactDir = await writeArtifacts('value', DOM);
    const c = await classifyOne(
      cfg,
      record({
        artifactDir,
        errorMessage:
          "AssertionError: expected 'Log In' to equal 'Sign In'\nlocator('#login-submit-btn')",
      }),
      index,
    );
    expect(c.verdict).toBe('value_failure');
  });

  it('refuses to fix a detached-element race', async () => {
    const artifactDir = await writeArtifacts('detached', DOM);
    const c = await classifyOne(
      cfg,
      record({
        artifactDir,
        errorMessage:
          "Error: element is not attached to the DOM\nlocator('#login-submit-btn')",
      }),
      index,
    );
    expect(c.verdict).toBe('timing');
  });

  it('reports target-closed as unusable evidence', async () => {
    const artifactDir = await writeArtifacts('closed', DOM);
    const c = await classifyOne(
      cfg,
      record({
        artifactDir,
        errorMessage: 'Target page, context or browser has been closed',
      }),
      index,
    );
    expect(c.verdict).toBe('no_evidence');
  });

  it('routes server errors to environment rather than a locator fix', async () => {
    const har = JSON.stringify({ log: { entries: [{ response: { status: 502 } }] } });
    const artifactDir = await writeArtifacts('env', DOM, har);
    const rec = record({
      artifactDir,
      errorMessage: "TimeoutError: waiting for locator('#btn-submit-login')",
    });
    rec.artifacts.har = path.join(artifactDir, 'network.har');
    const c = await classifyOne(cfg, rec, index);
    expect(c.verdict).toBe('environment');
  });

  it('marks a repeating strict mode violation fixable', async () => {
    const artifactDir = await writeArtifacts('strict-ok', DOM);
    const c = await classifyOne(
      cfg,
      record({
        artifactDir,
        errorMessage: `strict mode violation: locator('.nav-item') resolved to 2 elements:
    1) <a href="/help" class="nav-item">Help Desk</a> aka getByRole('link', { name: 'Help Desk' })
    2) <a href="/roles" class="nav-item">Role Request</a> aka getByRole('link', { name: 'Role Request' })`,
      }),
      index,
    );
    expect(c.verdict).toBe('fixable');
    expect(c.strictMode?.structure).toBe('repeating');
  });

  it('refuses to disambiguate an apparent duplicate render', async () => {
    const artifactDir = await writeArtifacts('strict-dupe', DOM);
    const c = await classifyOne(
      cfg,
      record({
        artifactDir,
        errorMessage: `strict mode violation: locator('.nav-item') resolved to 2 elements:
    1) <a class="nav-item">Help Desk</a>
    2) <a class="nav-item">Help Desk</a>`,
      }),
      index,
    );
    expect(c.verdict).toBe('duplicate_render');
  });

  it('reports no_evidence when the selector maps to nothing indexed', async () => {
    const artifactDir = await writeArtifacts('unmapped', DOM);
    const c = await classifyOne(
      cfg,
      record({ artifactDir, errorMessage: "waiting for locator('#totally-unknown')" }),
      index,
    );
    expect(c.verdict).toBe('no_evidence');
  });
});

describe('group', () => {
  const make = (
    symbol: string,
    tag: string,
    verdict: ClassifiedFailure['verdict'],
  ): ClassifiedFailure => ({
    record: record({ artifactDir: '/tmp/x', tag }),
    signature: 'locator_timeout',
    verdict,
    rationale: 'test',
    definition: DEFS.find((d) => d.symbol === symbol)!,
  });

  it('collapses many failures onto the line a fix would edit', () => {
    const groups = group([
      make('submitButton', '@login', 'fixable'),
      make('submitButton', '@helpdesk', 'fixable'),
      make('submitButton', '@roles', 'fixable'),
      make('navItem', '@login', 'fixable'),
    ]);
    expect(groups).toHaveLength(2);
    const login = groups.find((g) => g.definition?.symbol === 'submitButton')!;
    expect(login.instanceCount).toBe(3);
    expect(login.affectedTags).toEqual(['@helpdesk', '@login', '@roles']);
  });

  it('lets a single regression reading override the majority', () => {
    const groups = group([
      make('submitButton', '@a', 'fixable'),
      make('submitButton', '@b', 'fixable'),
      make('submitButton', '@c', 'regression'),
    ]);
    expect(groups[0]!.verdict).toBe('regression');
  });

  it('orders groups by blast radius', () => {
    const groups = group([
      make('navItem', '@a', 'fixable'),
      make('submitButton', '@a', 'fixable'),
      make('submitButton', '@b', 'fixable'),
    ]);
    expect(groups[0]!.definition?.symbol).toBe('submitButton');
  });
});

describe('cascadeGuard', () => {
  const envFailure = (tag: string): ClassifiedFailure => ({
    record: record({ artifactDir: '/tmp/x', tag }),
    signature: 'http_error',
    verdict: 'environment',
    rationale: '5xx',
  });

  it('trips when most failures are server errors', () => {
    const r = cascadeGuard(cfg, [envFailure('@a'), envFailure('@b'), envFailure('@c')]);
    expect(r.tripped).toBe(true);
  });

  it('trips when every tag fails at a shared entry step', () => {
    const failures: ClassifiedFailure[] = ['@a', '@b', '@c', '@d'].map((tag) => ({
      record: record({
        artifactDir: '/tmp/x',
        tag,
        failingStepText: 'Given I log in to the portal',
      }),
      signature: 'locator_timeout',
      verdict: 'fixable',
      rationale: 'x',
    }));
    expect(cascadeGuard(cfg, failures).tripped).toBe(true);
  });

  it('stays quiet on an ordinary run', () => {
    const failures: ClassifiedFailure[] = [
      {
        record: record({ artifactDir: '/tmp/x', tag: '@login' }),
        signature: 'locator_timeout',
        verdict: 'fixable',
        rationale: 'x',
      },
    ];
    expect(cascadeGuard(cfg, failures).tripped).toBe(false);
  });

  it('is a no-op with no failures', () => {
    expect(cascadeGuard(cfg, []).tripped).toBe(false);
  });
});
