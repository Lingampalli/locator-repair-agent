#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, type Config } from './config.js';
import { collect, withArtifacts } from './collect.js';
import { LocatorIndex } from './locator.js';
import { classify, group, cascadeGuard } from './classify.js';
import { Proposer } from './propose.js';
import { Patcher } from './patch.js';
import { verifyGroup } from './verify.js';
import { PullRequestCreator, type CommitPlan } from './pr.js';
import { renderTriageReport, renderConsoleSummary } from './report.js';
import { isFixable, type FailureGroup, type PatchResult, type Proposal, type RunSummary, type VerifyResult } from './types.js';
import { log, setLogLevel, type LogLevel } from './logger.js';

/**
 * Orchestration: collect -> classify -> group -> propose -> patch -> verify -> PR.
 *
 * `report-only` is the default and runs everything up to and including
 * proposals, but never patches, verifies or opens anything.
 */

interface CliOptions {
  builds: string;
  mode: 'report-only' | 'propose-pr';
  efsRoot?: string;
  repoRoot?: string;
  config?: string;
  out?: string;
  logLevel?: LogLevel;
  dryRun?: boolean;
}

function banner(cfg: Config, builds: string[], mode: string): void {
  log.step('Locator Repair Agent');
  console.log(`  builds        : ${builds.join(', ')}`);
  console.log(`  mode          : ${mode}`);
  console.log(`  efsRoot       : ${cfg.efsRoot}`);
  console.log(`  repoRoot      : ${cfg.repoRoot}`);
  console.log(`  pageObjectDir : ${cfg.pageObjectDir}`);
  console.log(`  model         : ${cfg.bedrockModelId}`);
  console.log('');
}

async function main(): Promise<number> {
  const program = new Command()
    .name('locator-agent')
    .description('Triage Playwright/Cucumber failures and propose verified locator fixes')
    .requiredOption('-b, --builds <numbers>', 'comma-separated Jenkins build numbers')
    .option('-m, --mode <mode>', 'report-only | propose-pr', 'report-only')
    .option('--efs-root <path>', 'override the EFS root')
    .option('--repo-root <path>', 'override the framework repository root')
    .option('-c, --config <path>', 'path to a config JSON file')
    .option('-o, --out <path>', 'write the Markdown report to this file')
    .option('--log-level <level>', 'debug | info | warn | error', 'info')
    .option('--dry-run', 'run everything except opening the pull request', false);

  program.parse();
  const opts = program.opts<CliOptions>();

  if (opts.logLevel) setLogLevel(opts.logLevel);

  const builds = opts.builds
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);

  if (builds.length === 0) {
    log.error('no build numbers supplied');
    return 2;
  }

  const cfg = await loadConfig(opts.config, {
    ...(opts.efsRoot ? { efsRoot: opts.efsRoot } : {}),
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
  });

  const mode = opts.mode === 'propose-pr' ? 'propose-pr' : 'report-only';
  banner(cfg, builds, mode);

  const startedAt = new Date().toISOString();

  // 1. COLLECT ---------------------------------------------------------------
  log.step('1/6 Collect');
  const records = await collect(cfg, builds);
  const evidenced = withArtifacts(records);
  log.info(`${records.length} failure(s), ${evidenced} with DOM/ARIA evidence`);

  if (records.length === 0) {
    log.warn('nothing to triage. Check efsRoot and the failureGlobs patterns in config.');
    return 0;
  }

  // 2. CLASSIFY + GROUP ------------------------------------------------------
  log.step('2/6 Classify and group');
  const index = LocatorIndex.build(cfg.repoRoot, cfg.pageObjectDir);
  const classified = await classify(cfg, records, index);

  const guard = cascadeGuard(cfg, classified);
  const groups = group(classified);

  const summary: RunSummary = {
    startedAt,
    finishedAt: startedAt,
    mode,
    buildsProcessed: builds,
    totalFailures: records.length,
    withArtifacts: evidenced,
    groups,
    proposals: [],
    patches: [],
    verifications: [],
    notFixed: [],
    cascadeGuardTripped: guard.tripped,
    cascadeGuardReason: guard.reason,
  };

  const recordNotFixed = (g: FailureGroup, rationale?: string): void => {
    summary.notFixed.push({
      groupId: g.groupId,
      verdict: g.verdict,
      rationale: rationale ?? g.rationale,
      tags: g.affectedTags,
    });
  };

  if (guard.tripped) {
    log.warn(`cascade guard tripped: ${guard.reason}`);
    for (const g of groups) recordNotFixed(g, 'run halted by the cascade guard');
    return await finish(cfg, summary, opts, 0);
  }

  const candidates = groups.filter((g) => isFixable(g.verdict));
  for (const g of groups) if (!isFixable(g.verdict)) recordNotFixed(g);

  log.info(`${candidates.length} of ${groups.length} group(s) are candidates for repair`);

  // 3. PROPOSE ---------------------------------------------------------------
  log.step('3/6 Propose');
  const proposer = new Proposer(cfg);
  const accepted: Array<{ group: FailureGroup; proposal: Proposal }> = [];

  for (const g of candidates) {
    const proposal = await proposer.propose(g);
    if (!proposal) {
      recordNotFixed(g, 'no acceptable locator proposal was produced');
      continue;
    }
    summary.proposals.push(proposal);

    if (proposal.verdict !== 'fixable' || !proposal.proposedLocator) {
      recordNotFixed(g, proposal.reasoning);
      continue;
    }
    accepted.push({ group: g, proposal });
  }
  log.info(`${accepted.length} proposal(s) accepted (${proposer.callCount} model call(s))`);

  if (mode === 'report-only') {
    log.info('report-only mode: stopping before any code change');
    for (const { group: g } of accepted) {
      recordNotFixed(g, 'proposal available but report-only mode was requested');
    }
    return await finish(cfg, summary, opts, 0);
  }

  // 4. PATCH + 5. VERIFY -----------------------------------------------------
  log.step('4/6 and 5/6 Patch and verify');
  const patcher = new Patcher(cfg);
  const plans: CommitPlan[] = [];

  for (const { group: g, proposal } of accepted) {
    const patch: PatchResult = patcher.apply(g, proposal);
    summary.patches.push(patch);

    if (!patch.applied) {
      log.warn(`${g.groupId}: patch not applied — ${patch.error}`);
      recordNotFixed(g, patch.error ?? 'patch could not be applied');
      continue;
    }

    const verification: VerifyResult = await verifyGroup(cfg, g);
    summary.verifications.push(verification);

    if (!verification.passed) {
      log.warn(`${g.groupId}: verification failed, reverting`);
      patcher.revertFile(patch.filePath);
      recordNotFixed(
        g,
        'a fix was proposed but did not pass verification, so it was discarded',
      );
      continue;
    }

    plans.push({ group: g, proposal, patch });
  }

  log.info(`${plans.length} fix(es) verified`);

  // 6. PULL REQUEST ----------------------------------------------------------
  log.step('6/6 Pull request');
  if (plans.length === 0) {
    log.info('nothing verified; no pull request');
    return await finish(cfg, summary, opts, 0);
  }

  if (opts.dryRun) {
    log.info('dry run: patches left in the working tree, no branch or pull request created');
    return await finish(cfg, summary, opts, 0);
  }

  const creator = new PullRequestCreator(cfg);
  const runLabel = builds.join('-');

  try {
    const branch = await creator.commitAll(plans, runLabel);
    if (branch) {
      await creator.push(branch);
      summary.prUrl = await creator.openPullRequest(branch, summary);
    }
  } catch (e) {
    log.error('failed to create the pull request', e);
    return await finish(cfg, summary, opts, 1);
  }

  return await finish(cfg, summary, opts, 0);
}

async function finish(
  _cfg: Config,
  summary: RunSummary,
  opts: CliOptions,
  code: number,
): Promise<number> {
  summary.finishedAt = new Date().toISOString();
  const markdown = renderTriageReport(summary);

  if (opts.out) {
    await mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
    await writeFile(opts.out, markdown, 'utf8');
    log.info(`report written to ${opts.out}`);
  }

  console.log(`\n${markdown}`);
  console.log(renderConsoleSummary(summary));
  return code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    log.error('unhandled error', err);
    process.exitCode = 1;
  });
