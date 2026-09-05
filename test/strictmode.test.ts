import { describe, it, expect } from 'vitest';
import {
  parseStrictMode,
  analyseStructure,
  suggestionsFrom,
  isDisambiguable,
  textOf,
  tagNameOf,
} from '../src/strictmode.js';

const REPEATING = `Error: strict mode violation: locator('.nav-item') resolved to 3 elements:
    1) <a class="nav-item" href="/help">Help Desk</a> aka getByRole('link', { name: 'Help Desk' })
    2) <a class="nav-item" href="/roles">Role Request</a> aka getByRole('link', { name: 'Role Request' })
    3) <a class="nav-item" href="/admin">Admin</a> aka getByRole('link', { name: 'Admin' })`;

const DUPLICATE = `Error: strict mode violation: locator('#approve') resolved to 2 elements:
    1) <button id="approve">Approve</button>
    2) <button id="approve">Approve</button>`;

const HIDDEN = `Error: strict mode violation: locator('.modal-close') resolved to 2 elements:
    1) <button class="modal-close">Close</button> aka getByRole('button', { name: 'Close' })
    2) <button class="modal-close" aria-hidden="true">Close</button>`;

const MIXED = `Error: strict mode violation: locator('text=Help Desk') resolved to 2 elements:
    1) <a href="/help">Help Desk</a> aka getByRole('link', { name: 'Help Desk' })
    2) <h2 class="title">Help Desk Overview</h2> aka getByRole('heading', { name: 'Help Desk Overview' })`;

describe('parseStrictMode', () => {
  it('extracts selector, count and matches', () => {
    const d = parseStrictMode(REPEATING);
    expect(d).toBeDefined();
    expect(d!.selector).toBe('.nav-item');
    expect(d!.matchCount).toBe(3);
    expect(d!.matches).toHaveLength(3);
    expect(d!.matches[0]!.html).toContain('Help Desk');
  });

  it('captures the "aka" suggestions Playwright provides', () => {
    const d = parseStrictMode(REPEATING)!;
    const suggestions = suggestionsFrom(d);
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]).toBe("getByRole('link', { name: 'Help Desk' })");
    // The suggestion must not be left inside the html snippet.
    expect(d.matches[0]!.html).not.toContain('aka');
  });

  it('returns undefined for a non-strict-mode error', () => {
    expect(parseStrictMode('TimeoutError: waiting for locator(\'#x\')')).toBeUndefined();
  });

  it('copes with matches that have no suggestion', () => {
    const d = parseStrictMode(DUPLICATE)!;
    expect(d.matches).toHaveLength(2);
    expect(suggestionsFrom(d)).toHaveLength(0);
  });
});

describe('analyseStructure', () => {
  it('reads a list of differing siblings as repeating', () => {
    expect(parseStrictMode(REPEATING)!.structure).toBe('repeating');
  });

  it('reads identical indistinguishable elements as a duplicate render', () => {
    expect(parseStrictMode(DUPLICATE)!.structure).toBe('duplicate');
  });

  it('flags a hidden match rather than disambiguating around it', () => {
    expect(parseStrictMode(HIDDEN)!.structure).toBe('hidden_present');
  });

  it('reads differing tags as distinct regions', () => {
    expect(parseStrictMode(MIXED)!.structure).toBe('distinct_regions');
  });

  it('is unknown for an empty match list', () => {
    expect(analyseStructure([])).toBe('unknown');
  });
});

describe('isDisambiguable', () => {
  it('permits repeating and distinct regions', () => {
    expect(isDisambiguable('repeating')).toBe(true);
    expect(isDisambiguable('distinct_regions')).toBe(true);
  });

  it('refuses duplicate renders and hidden matches, which would hide a defect', () => {
    expect(isDisambiguable('duplicate')).toBe(false);
    expect(isDisambiguable('hidden_present')).toBe(false);
    expect(isDisambiguable('unknown')).toBe(false);
  });
});

describe('html helpers', () => {
  it('extracts tag names and visible text', () => {
    expect(tagNameOf('<a class="x">Hi</a>')).toBe('a');
    expect(textOf('<a class="x"><span>Help</span> Desk</a>')).toBe('Help Desk');
  });
});
