import path from 'node:path';
import { Project, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { LocatorDefinition } from './types.js';
import { log } from './logger.js';

/**
 * Static index of every locator defined in the page object directory.
 *
 * This is what lets the agent go from a Playwright error message — which
 * contains the selector — back to the exact line of code a fix would edit,
 * without needing a trace or any runtime instrumentation.
 */

const BUILDERS = new Set([
  'locator',
  'getByRole',
  'getByLabel',
  'getByPlaceholder',
  'getByTestId',
  'getByText',
  'getByTitle',
  'getByAltText',
]);

/** Strip quotes from a string literal's text. */
function unquote(text: string): string {
  const t = text.trim();
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith('`') && t.endsWith('`'))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Walk outwards from a call expression to the named declaration that holds it,
 * so `readonly submitButton = page.locator('#x')` yields "submitButton".
 */
function findOwningSymbol(call: CallExpression): string | undefined {
  let node = call.getParent();
  while (node) {
    const kind = node.getKind();
    if (
      kind === SyntaxKind.PropertyDeclaration ||
      kind === SyntaxKind.PropertyAssignment ||
      kind === SyntaxKind.MethodDeclaration ||
      kind === SyntaxKind.GetAccessor ||
      kind === SyntaxKind.VariableDeclaration
    ) {
      const named = node.asKind(kind) as { getName?: () => string } | undefined;
      if (named?.getName) return named.getName();
    }
    node = node.getParent();
  }
  return undefined;
}

/** Pull the `name` property out of a getByRole options object literal. */
function extractRoleName(call: CallExpression): string | undefined {
  const arg = call.getArguments()[1];
  if (!arg) return undefined;
  const obj = arg.asKind(SyntaxKind.ObjectLiteralExpression);
  if (!obj) return undefined;
  const prop = obj.getProperty('name');
  if (!prop) return undefined;
  const init = prop.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
  return init ? unquote(init.getText()) : undefined;
}

function extractFromSourceFile(sf: SourceFile): LocatorDefinition[] {
  const out: LocatorDefinition[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const propAccess = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
    if (!propAccess) continue;

    const builder = propAccess.getName();
    if (!BUILDERS.has(builder)) continue;

    // Skip chained calls like `.filter(...)` applied to an outer expression;
    // we want the outermost builder call in the chain.
    const parentCall = call.getParent()?.asKind(SyntaxKind.PropertyAccessExpression);
    if (parentCall && BUILDERS.has(parentCall.getName())) continue;

    const symbol = findOwningSymbol(call);
    if (!symbol) continue;

    const firstArg = call.getArguments()[0];
    const firstText = firstArg ? unquote(firstArg.getText()) : '';

    const isRole = builder === 'getByRole';
    const roleName = isRole ? extractRoleName(call) : undefined;

    out.push({
      filePath: sf.getFilePath(),
      symbol,
      // Capture the whole chain so `.filter(...)` survives round-tripping.
      expression: (call.getParent()?.getKind() === SyntaxKind.PropertyAccessExpression
        ? call.getParent()!.getParent()?.getText()
        : undefined) ?? call.getText(),
      builder,
      selectorValue: isRole ? (roleName ?? firstText) : firstText,
      role: isRole ? firstText : undefined,
      line: call.getStartLineNumber(),
    });
  }

  return out;
}

export class LocatorIndex {
  private readonly definitions: LocatorDefinition[] = [];

  private constructor(defs: LocatorDefinition[]) {
    this.definitions = defs;
  }

  static build(repoRoot: string, pageObjectDir: string): LocatorIndex {
    const absDir = path.isAbsolute(pageObjectDir)
      ? pageObjectDir
      : path.join(repoRoot, pageObjectDir);

    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: false },
    });

    project.addSourceFilesAtPaths([
      path.join(absDir, '**/*.ts'),
      `!${path.join(absDir, '**/*.d.ts')}`,
    ]);

    const defs: LocatorDefinition[] = [];
    for (const sf of project.getSourceFiles()) {
      try {
        defs.push(...extractFromSourceFile(sf));
      } catch (e) {
        log.warn(`failed to index ${sf.getFilePath()}`, e);
      }
    }

    log.info(
      `indexed ${defs.length} locator(s) across ${project.getSourceFiles().length} page object file(s)`,
    );
    return new LocatorIndex(defs);
  }

  /** Test seam: build an index from in-memory definitions. */
  static fromDefinitions(defs: LocatorDefinition[]): LocatorIndex {
    return new LocatorIndex(defs);
  }

  all(): readonly LocatorDefinition[] {
    return this.definitions;
  }

  /**
   * Find the definition a Playwright error's selector refers to.
   *
   * Playwright reports the selector it was given, so an exact match on
   * `selectorValue` is the common case. Falls back to substring matching for
   * selectors Playwright normalised (e.g. added `internal:` prefixes).
   */
  findBySelector(selector: string): LocatorDefinition | undefined {
    const needle = selector.trim();
    if (!needle) return undefined;

    const exact = this.definitions.find((d) => d.selectorValue === needle);
    if (exact) return exact;

    const unquoted = unquote(needle);
    const exactUnquoted = this.definitions.find((d) => d.selectorValue === unquoted);
    if (exactUnquoted) return exactUnquoted;

    // Playwright may render getByRole as internal:role=button[name="Sign In"i]
    const roleMatch = /internal:role=([a-z]+)(?:\[name="([^"]*)")?/i.exec(needle);
    if (roleMatch) {
      const [, role, name] = roleMatch;
      const byRole = this.definitions.find(
        (d) => d.role === role && (!name || d.selectorValue === name),
      );
      if (byRole) return byRole;
    }

    const testIdMatch = /internal:testid=\[?([^\]\s=]+)/i.exec(needle);
    if (testIdMatch?.[1]) {
      const byTestId = this.definitions.find((d) => d.selectorValue === testIdMatch[1]);
      if (byTestId) return byTestId;
    }

    return this.definitions.find(
      (d) => d.selectorValue.length > 2 && needle.includes(d.selectorValue),
    );
  }

  find(filePath: string, symbol: string): LocatorDefinition | undefined {
    return this.definitions.find((d) => d.filePath === filePath && d.symbol === symbol);
  }

  /**
   * Resolve a locator reference parsed out of an error message.
   *
   * Richer than `findBySelector` because a `getByRole` error carries both the
   * role and the accessible name, and matching on the role alone would collide
   * with every other control of that role.
   */
  findByRef(ref: LocatorRef): LocatorDefinition | undefined {
    if (ref.builder === 'getByRole') {
      const withName = this.definitions.find(
        (d) => d.role === ref.primary && ref.name !== undefined && d.selectorValue === ref.name,
      );
      if (withName) return withName;
      const byRoleOnly = this.definitions.filter((d) => d.role === ref.primary);
      if (byRoleOnly.length === 1) return byRoleOnly[0];
      return undefined;
    }

    if (ref.builder && ref.builder !== 'locator') {
      const byBuilder = this.definitions.find(
        (d) => d.builder === ref.builder && d.selectorValue === ref.primary,
      );
      if (byBuilder) return byBuilder;
    }

    return this.findBySelector(ref.primary);
  }
}

/** A locator call recovered from an error message. */
export interface LocatorRef {
  builder?: string;
  primary: string;
  name?: string;
}

/**
 * Recover the locator call Playwright reported, including the accessible name
 * for `getByRole`. Falls back to a bare selector for `locator()` forms.
 */
export function extractLocatorRef(message: string): LocatorRef | undefined {
  const call =
    /(?:waiting for|violation:)\s*(locator|getBy[A-Za-z]+)\(([\s\S]*?)\)\s*(?:resolved|$|\n)/i.exec(
      message,
    ) ?? /(locator|getBy[A-Za-z]+)\(([\s\S]*?)\)\s*resolved to/i.exec(message);

  const fallback = call ?? /(locator|getBy[A-Za-z]+)\(([^\n]*?)\)/i.exec(message);
  if (!fallback) return undefined;

  const builder = fallback[1];
  const args = fallback[2] ?? '';

  const primaryMatch = /^\s*(['"`])([\s\S]*?)\1/.exec(args);
  const primary = primaryMatch?.[2] ?? unquote(args.split(',')[0]!.trim());

  const nameMatch = /name\s*:\s*(['"`])([\s\S]*?)\1/.exec(args);

  return { builder, primary, name: nameMatch?.[2] };
}

/**
 * Extract the selector Playwright reported in an error message.
 *
 * Handles the common shapes:
 *   waiting for locator('#btn-submit')
 *   strict mode violation: locator('.nav-item') resolved to 3 elements
 *   locator.click: Timeout ... waiting for getByRole('button')
 */
export function extractSelectorFromError(message: string): string | undefined {
  const patterns = [
    /(?:waiting for|violation:)\s*(?:locator|getBy\w+)\(([^)]*)\)/i,
    /(?:locator|getBy\w+)\(([^)]*)\)\s*resolved to/i,
    /locator\(([^)]*)\)/i,
  ];
  for (const p of patterns) {
    const m = p.exec(message);
    if (m?.[1]) return unquote(m[1].split(',')[0]!.trim());
  }
  return undefined;
}
