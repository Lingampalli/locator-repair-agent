import path from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import type { Config } from './config.js';
import type { FailureGroup, PatchResult, Proposal } from './types.js';
import { log } from './logger.js';

/**
 * Apply a proposed locator to a page object using AST edits.
 *
 * Regex replacement is deliberately not used: locator strings recur across
 * page objects, and naive replacement corrupts unrelated code.
 *
 * The write-path allowlist is enforced here rather than trusted upstream. Only
 * the page object directory is writable. Feature files are the product-owned
 * specification and the agent has no write path to them at all.
 */

export class Patcher {
  private readonly project: Project;
  private readonly pageObjectDirAbs: string;
  /** Original file text, keyed by path, so patches can be reverted. */
  private readonly originals = new Map<string, string>();

  constructor(private readonly cfg: Config) {
    this.pageObjectDirAbs = path.resolve(cfg.repoRoot, cfg.pageObjectDir);
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: false },
    });
  }

  /** True when `filePath` resolves inside the page object directory. */
  isWritable(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const rel = path.relative(this.pageObjectDirAbs, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  apply(group: FailureGroup, proposal: Proposal): PatchResult {
    const def = group.definition;
    const fail = (error: string): PatchResult => ({
      groupId: group.groupId,
      filePath: def?.filePath ?? 'unknown',
      symbol: def?.symbol ?? 'unknown',
      before: def?.expression ?? '',
      after: proposal.proposedLocator,
      applied: false,
      error,
    });

    if (!def) return fail('group has no resolved locator definition');

    if (!this.isWritable(def.filePath)) {
      return fail(
        `refusing to write outside ${this.cfg.pageObjectDir}: ${def.filePath}. ` +
          `Feature files, step definitions, hooks and assertion helpers are never modified`,
      );
    }

    let sourceFile;
    try {
      sourceFile = this.project.addSourceFileAtPath(def.filePath);
    } catch (e) {
      return fail(`could not open ${def.filePath}: ${String(e)}`);
    }

    if (!this.originals.has(def.filePath)) {
      this.originals.set(def.filePath, sourceFile.getFullText());
    }

    // Find the exact call expression again by symbol and original text, so we
    // never rely on a line number that an earlier patch may have shifted.
    const target = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((call) => {
        if (call.getText() !== def.expression) return false;
        let node = call.getParent();
        while (node) {
          const named = node as unknown as { getName?: () => string };
          if (typeof named.getName === 'function' && named.getName() === def.symbol) return true;
          node = node.getParent();
        }
        return false;
      });

    if (!target) {
      return fail(
        `could not locate the original expression for ${def.symbol} in ${path.basename(def.filePath)} — the file may have changed since indexing`,
      );
    }

    try {
      target.replaceWithText(proposal.proposedLocator);
      sourceFile.saveSync();
    } catch (e) {
      return fail(`AST replacement failed: ${String(e)}`);
    }

    log.info(`patched ${path.basename(def.filePath)}::${def.symbol}`);
    return {
      groupId: group.groupId,
      filePath: def.filePath,
      symbol: def.symbol,
      before: def.expression,
      after: proposal.proposedLocator,
      applied: true,
    };
  }

  /** Restore a single file to the text it had before any patch was applied. */
  revertFile(filePath: string): void {
    const original = this.originals.get(filePath);
    if (original === undefined) return;
    const sf = this.project.getSourceFile(filePath);
    if (!sf) return;
    sf.replaceWithText(original);
    sf.saveSync();
    log.info(`reverted ${path.basename(filePath)}`);
  }

  /** Restore every file this patcher has touched. */
  revertAll(): void {
    for (const filePath of this.originals.keys()) this.revertFile(filePath);
  }

  /** Re-apply a set of patches after a revert, used to rebuild a clean state. */
  reapply(patches: Array<{ group: FailureGroup; proposal: Proposal }>): PatchResult[] {
    return patches.map(({ group, proposal }) => this.apply(group, proposal));
  }
}
