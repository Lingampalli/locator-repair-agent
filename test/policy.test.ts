import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BANNED_PROPOSAL_PATTERNS, ConfigSchema } from '../src/config.js';
import { Patcher } from '../src/patch.js';
import { LocatorIndex, extractSelectorFromError } from '../src/locator.js';
import { tryPlaywrightSuggestions, pruneDom } from '../src/propose.js';
import type { FailureGroup } from '../src/types.js';

/**
 * These tests cover the four rules. They are the ones that must never regress:
 * a failure here means the agent could make a change it should not.
 */

function banned(expression: string): boolean {
  return BANNED_PROPOSAL_PATTERNS.some(({ pattern }) => pattern.test(expression));
}

describe('rule 3 — index-based selection is never proposed', () => {
  it.each([
    "page.getByRole('button').first()",
    "page.getByRole('button').last()",
    "page.locator('.row').nth(2)",
    "page.locator('tr:nth-child(3)')",
    "page.locator('xpath=//div[@id=\"x\"]')",
    "page.locator('.css-1a2b3c')",
    "page.getByRole('button', { timeout: 60000 })",
    "page.waitForTimeout(5000)",
  ])('rejects %s', (expression) => {
    expect(banned(expression)).toBe(true);
  });

  it.each([
    "page.getByRole('button', { name: 'Sign In' })",
    "page.getByRole('navigation').getByRole('link', { name: 'Help Desk' })",
    "page.getByRole('row').filter({ hasText: 'Approver' }).getByRole('cell')",
    "page.getByTestId('submit-login')",
  ])('accepts %s', (expression) => {
    expect(banned(expression)).toBe(false);
  });
});

describe('rule 3 — Playwright suggestions are policy-checked too', () => {
  const domWithOne = '<html><body><a href="/help">Help Desk</a></body></html>';

  const makeGroup = (suggestion: string): FailureGroup => ({
    groupId: 'g1',
    signature: 'strict_mode',
    verdict: 'fixable',
    rationale: 'x',
    failures: [],
    affectedTags: ['@login'],
    instanceCount: 1,
    strictMode: {
      selector: '.nav-item',
      matchCount: 2,
      matches: [{ index: 1, html: '<a href="/help">Help Desk</a>', suggestion }],
      structure: 'repeating',
    },
  });

  it('accepts a suggestion that resolves to exactly one element', () => {
    const p = tryPlaywrightSuggestions(
      makeGroup("getByRole('link', { name: 'Help Desk' })"),
      domWithOne,
      undefined,
    );
    expect(p).toBeDefined();
    expect(p!.source).toBe('playwright_suggestion');
    expect(p!.proposedLocator).toContain('getByRole');
  });

  it('rejects a banned suggestion even when Playwright offered it', () => {
    const p = tryPlaywrightSuggestions(
      makeGroup("getByRole('link').first()"),
      domWithOne,
      undefined,
    );
    expect(p).toBeUndefined();
  });

  it('rejects a suggestion that does not resolve to exactly one element', () => {
    const p = tryPlaywrightSuggestions(
      makeGroup("getByRole('link', { name: 'Nonexistent' })"),
      domWithOne,
      undefined,
    );
    expect(p).toBeUndefined();
  });
});

describe('rule 3 (write path) — only page objects are writable', () => {
  let repo: string;
  let patcher: Patcher;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'lra-repo-'));
    await mkdir(path.join(repo, 'src', 'pages'), { recursive: true });
    await mkdir(path.join(repo, 'features'), { recursive: true });
    await mkdir(path.join(repo, 'src', 'support'), { recursive: true });
    patcher = new Patcher(
      ConfigSchema.parse({ repoRoot: repo, pageObjectDir: 'src/pages' }),
    );
  });

  it('permits a page object', () => {
    expect(patcher.isWritable(path.join(repo, 'src/pages/LoginPage.ts'))).toBe(true);
  });

  it('refuses feature files, which are the product-owned specification', () => {
    expect(patcher.isWritable(path.join(repo, 'features/login.feature'))).toBe(false);
  });

  it('refuses support files, hooks and assertion helpers', () => {
    expect(patcher.isWritable(path.join(repo, 'src/support/hooks.ts'))).toBe(false);
  });

  it('refuses a path traversal out of the page object directory', () => {
    expect(patcher.isWritable(path.join(repo, 'src/pages/../support/hooks.ts'))).toBe(false);
  });

  it('refuses the page object directory itself', () => {
    expect(patcher.isWritable(path.join(repo, 'src/pages'))).toBe(false);
  });
});

describe('locator index and error parsing', () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'lra-idx-'));
    const pages = path.join(repo, 'src', 'pages');
    await mkdir(pages, { recursive: true });
    await writeFile(
      path.join(pages, 'LoginPage.ts'),
      `import type { Page } from '@playwright/test';
export class LoginPage {
  constructor(private readonly page: Page) {}
  readonly submitButton = this.page.locator('#btn-submit-login');
  readonly username = this.page.getByRole('textbox', { name: 'Username' });
  get helpLink() { return this.page.getByTestId('help-link'); }
}
`,
      'utf8',
    );
  });

  it('indexes locators across builder styles', () => {
    const index = LocatorIndex.build(repo, 'src/pages');
    const all = index.all();
    expect(all.map((d) => d.symbol).sort()).toEqual(['helpLink', 'submitButton', 'username']);

    const submit = all.find((d) => d.symbol === 'submitButton')!;
    expect(submit.selectorValue).toBe('#btn-submit-login');

    const username = all.find((d) => d.symbol === 'username')!;
    expect(username.role).toBe('textbox');
    expect(username.selectorValue).toBe('Username');
  });

  it('maps a Playwright error back to the page object line', () => {
    const index = LocatorIndex.build(repo, 'src/pages');
    const selector = extractSelectorFromError(
      "TimeoutError: locator.click: Timeout 30000ms exceeded.\nwaiting for locator('#btn-submit-login')",
    );
    expect(selector).toBe('#btn-submit-login');
    expect(index.findBySelector(selector!)?.symbol).toBe('submitButton');
  });

  it('extracts the selector from a strict mode error', () => {
    expect(
      extractSelectorFromError("strict mode violation: locator('.nav-item') resolved to 3 elements:"),
    ).toBe('.nav-item');
  });

  it('returns undefined when no selector is present', () => {
    expect(extractSelectorFromError('AssertionError: expected 1 to equal 2')).toBeUndefined();
  });
});

describe('pruneDom', () => {
  it('strips scripts, styles and comments', () => {
    const out = pruneDom(
      '<html><script>var x=1</script><style>a{}</style><!-- c --><body><p>hi</p></body></html>',
    );
    expect(out).not.toContain('var x=1');
    expect(out).not.toContain('a{}');
    expect(out).not.toContain('<!-- c -->');
    expect(out).toContain('<p>hi</p>');
  });

  it('truncates very large documents', () => {
    const out = pruneDom(`<body>${'x'.repeat(200_000)}</body>`, 1000);
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain('truncated');
  });
});
