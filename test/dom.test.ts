import { describe, it, expect } from 'vitest';
import {
  probe,
  parseLocatorExpression,
  hasEquivalentElement,
  countInAriaSnapshot,
  harHasHttpErrors,
} from '../src/dom.js';

const DOM = `<!doctype html><html><body>
  <header><a href="/help" class="nav-item">Help Desk</a></header>
  <main>
    <form>
      <label for="user">Username</label>
      <input id="user" type="text" name="user" />
      <button id="login-submit-btn" type="submit">Sign In</button>
    </form>
    <table><tr><td>Approver</td><td>Reviewer</td></tr></table>
  </main>
  <footer><a href="/help" class="nav-item">Help Desk</a></footer>
</body></html>`;

const ARIA = `- banner:
  - link "Help Desk"
- main:
  - textbox "Username"
  - button "Sign In"
- contentinfo:
  - link "Help Desk"`;

describe('parseLocatorExpression', () => {
  it('parses a CSS locator', () => {
    const p = parseLocatorExpression("page.locator('#login-submit-btn')")!;
    expect(p.builder).toBe('locator');
    expect(p.primary).toBe('#login-submit-btn');
  });

  it('parses getByRole with an accessible name', () => {
    const p = parseLocatorExpression("page.getByRole('button', { name: 'Sign In' })")!;
    expect(p.builder).toBe('getByRole');
    expect(p.primary).toBe('button');
    expect(p.accessibleName).toBe('Sign In');
  });

  it('flags chained locators it cannot model statically', () => {
    const p = parseLocatorExpression(
      "page.getByRole('row').filter({ hasText: 'Approver' }).getByRole('cell')",
    )!;
    expect(p.hasUnsupportedChain).toBe(true);
  });

  it('returns undefined for something that is not a locator', () => {
    expect(parseLocatorExpression('someHelper(42)')).toBeUndefined();
  });
});

describe('probe', () => {
  it('reports zero matches for a locator that no longer resolves', () => {
    const r = probe("page.locator('#btn-submit-login')", DOM);
    expect(r.indeterminate).toBe(false);
    expect(r.matchCount).toBe(0);
  });

  it('reports one match for a locator that still resolves', () => {
    const r = probe("page.locator('#login-submit-btn')", DOM);
    expect(r.matchCount).toBe(1);
  });

  it('counts multiple matches, which is the strict mode case', () => {
    const r = probe("page.locator('.nav-item')", DOM);
    expect(r.matchCount).toBe(2);
  });

  it('resolves getByRole through implicit roles in the DOM', () => {
    const r = probe("page.getByRole('button', { name: 'Sign In' })", DOM);
    expect(r.matchCount).toBe(1);
  });

  it('prefers the ARIA snapshot for role-based locators', () => {
    const r = probe("page.getByRole('link', { name: 'Help Desk' })", undefined, ARIA);
    expect(r.indeterminate).toBe(false);
    expect(r.matchCount).toBe(2);
  });

  it('is indeterminate with no evidence at all', () => {
    const r = probe("page.locator('#x')", undefined, undefined);
    expect(r.indeterminate).toBe(true);
  });

  it('is indeterminate for a chained locator rather than guessing', () => {
    const r = probe("page.getByRole('row').filter({ hasText: 'x' }).getByRole('cell')", DOM);
    expect(r.indeterminate).toBe(true);
  });

  it('resolves getByLabel via the label element', () => {
    expect(probe("page.getByLabel('Username')", DOM).matchCount).toBe(1);
  });
});

describe('hasEquivalentElement — the safety check', () => {
  it('is true when the control is still present under a new selector', () => {
    expect(hasEquivalentElement('button', 'Sign In', DOM)).toBe(true);
  });

  it('is false when the control is genuinely gone', () => {
    expect(hasEquivalentElement('textbox', 'Search requests', DOM)).toBe(false);
  });

  it('works from an ARIA snapshot alone', () => {
    expect(hasEquivalentElement('button', 'Sign In', undefined, ARIA)).toBe(true);
    expect(hasEquivalentElement('button', 'Delete', undefined, ARIA)).toBe(false);
  });

  it('is false with nothing to go on', () => {
    expect(hasEquivalentElement(undefined, undefined, DOM)).toBe(false);
  });
});

describe('countInAriaSnapshot', () => {
  it('counts role and name pairs', () => {
    expect(countInAriaSnapshot(ARIA, 'link', 'Help Desk')).toBe(2);
    expect(countInAriaSnapshot(ARIA, 'button', 'Sign In')).toBe(1);
    expect(countInAriaSnapshot(ARIA, 'button', 'Missing')).toBe(0);
  });

  it('handles the accessibility-tree JSON fallback', () => {
    const json = JSON.stringify({
      role: 'WebArea',
      children: [
        { role: 'button', name: 'Sign In' },
        { role: 'button', name: 'Cancel' },
      ],
    });
    expect(countInAriaSnapshot(json, 'button', 'Sign In')).toBe(1);
    expect(countInAriaSnapshot(json, 'button')).toBe(2);
  });
});

describe('harHasHttpErrors', () => {
  it('finds server errors', () => {
    const har = JSON.stringify({
      log: { entries: [{ response: { status: 200 } }, { response: { status: 503 } }] },
    });
    const r = harHasHttpErrors(har);
    expect(r.found).toBe(true);
    expect(r.statuses).toContain(503);
  });

  it('is quiet on a clean HAR', () => {
    const har = JSON.stringify({ log: { entries: [{ response: { status: 200 } }] } });
    expect(harHasHttpErrors(har).found).toBe(false);
  });

  it('does not throw on malformed input', () => {
    expect(harHasHttpErrors('not json').found).toBe(false);
  });
});
