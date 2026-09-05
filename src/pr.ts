import path from 'node:path';
import { Octokit } from '@octokit/rest';
import type { Config } from './config.js';
import type { FailureGroup, PatchResult, Proposal, RunSummary } from './types.js';
import { runCommand } from './verify.js';
import { renderPullRequestBody } from './report.js';
import { log } from './logger.js';

/**
 * Create one branch, one commit per verified fix, and one pull request.
 *
 * One commit per fix is deliberate: it lets the reviewing engineer drop a
 * single bad change rather than rejecting the whole pull request.
 *
 * The agent has no merge capability. That must also be enforced by the token's
 * scope, not by this code alone.
 */

const COMMIT_TRAILER = [
  '',
  'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
  'Claude-Session: https://claude.ai/code/session_01H4dTb4fTR6B9C2TKUE5vTy',
].join('\n');

export interface CommitPlan {
  group: FailureGroup;
  proposal: Proposal;
  patch: PatchResult;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commitMessage(plan: CommitPlan): string {
  const { group, proposal, patch } = plan;
  const file = path.basename(patch.filePath);
  const cause =
    group.signature === 'strict_mode'
      ? `strict mode violation (${group.strictMode?.matchCount ?? '?'} matches)`
      : 'locator no longer matches';

  return [
    `fix(locators): repair ${patch.symbol} in ${file}`,
    '',
    `Cause: ${cause}`,
    `Before: ${patch.before}`,
    `After:  ${patch.after}`,
    '',
    `Affected ${group.instanceCount} scenario failure(s) across ${group.affectedTags.length} tag(s):`,
    `${group.affectedTags.join(', ')}`,
    '',
    `Source: ${proposal.source === 'playwright_suggestion' ? "Playwright's own suggestion" : 'Bedrock'}`,
    `Confidence: ${proposal.confidence.toFixed(2)}`,
    `Rationale: ${proposal.reasoning}`,
    COMMIT_TRAILER,
  ].join('\n');
}

async function git(args: string, cwd: string): Promise<string> {
  const outcome = await runCommand(`git ${args}`, cwd, 120_000);
  if (!outcome.ok) throw new Error(`git ${args} failed:\n${outcome.output}`);
  return outcome.output;
}

export class PullRequestCreator {
  constructor(private readonly cfg: Config) {}

  /**
   * Stage and commit each verified fix on a fresh branch.
   * Returns the branch name, or undefined when there was nothing to commit.
   */
  async commitAll(plans: CommitPlan[], runLabel: string): Promise<string | undefined> {
    if (plans.length === 0) return undefined;

    const branch = `${this.cfg.github.branchPrefix}/${runLabel}`;
    const cwd = this.cfg.repoRoot;

    await git(`checkout -B ${shellQuote(branch)}`, cwd);

    let committed = 0;
    for (const plan of plans) {
      if (!plan.patch.applied) continue;
      const rel = path.relative(cwd, plan.patch.filePath);
      await git(`add -- ${shellQuote(rel)}`, cwd);

      const status = await runCommand('git diff --cached --quiet', cwd, 30_000);
      if (status.ok) {
        log.warn(`${plan.group.groupId}: nothing staged, skipping commit`);
        continue;
      }

      await git(`commit -m ${shellQuote(commitMessage(plan))}`, cwd);
      committed += 1;
    }

    if (committed === 0) {
      log.warn('no commits produced; not opening a pull request');
      return undefined;
    }

    log.info(`created ${committed} commit(s) on ${branch}`);
    return branch;
  }

  async push(branch: string): Promise<void> {
    await git(`push --set-upstream origin ${shellQuote(branch)} --force-with-lease`, this.cfg.repoRoot);
    log.info(`pushed ${branch}`);
  }

  async openPullRequest(branch: string, summary: RunSummary): Promise<string> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is not set');

    const octokit = new Octokit({
      auth: token,
      ...(this.cfg.github.apiBaseUrl ? { baseUrl: this.cfg.github.apiBaseUrl } : {}),
    });

    const verifiedCount = summary.verifications.filter((v) => v.passed).length;
    const title = `Locator fixes: ${verifiedCount} verified repair${verifiedCount === 1 ? '' : 's'} from builds ${summary.buildsProcessed.join(', ')}`;

    const response = await octokit.pulls.create({
      owner: this.cfg.github.owner,
      repo: this.cfg.github.repo,
      head: branch,
      base: this.cfg.github.baseBranch,
      title,
      body: renderPullRequestBody(summary),
      maintainer_can_modify: true,
    });

    const url = response.data.html_url;

    try {
      await octokit.issues.addLabels({
        owner: this.cfg.github.owner,
        repo: this.cfg.github.repo,
        issue_number: response.data.number,
        labels: ['ai-locator-repair', 'needs-human-review'],
      });
    } catch (e) {
      log.warn('could not add labels (they may not exist in the repo)', e);
    }

    log.info(`opened pull request ${url}`);
    return url;
  }
}
