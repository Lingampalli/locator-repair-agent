import path from 'node:path';
import type { FailureGroup, RunSummary, Verdict } from './types.js';

/**
 * Render the run as Markdown. Used both for the console/email triage report
 * and as the body of the pull request.
 *
 * What the agent declined to touch matters as much as what it fixed, so the
 * "not fixed" section is never omitted.
 */

const VERDICT_LABEL: Record<Verdict, string> = {
  fixable: 'Fixable',
  regression: 'Suspected regression',
  duplicate_render: 'Possible duplicate render',
  value_failure: 'Genuine test failure',
  environment: 'Environment or application error',
  timing: 'Timing / re-render race',
  no_evidence: 'No usable evidence',
  unclear: 'Inconclusive',
};

function short(filePath: string): string {
  return filePath === 'unknown' ? filePath : path.basename(filePath);
}

function groupLabel(g: FailureGroup): string {
  return g.definition ? `${short(g.definition.filePath)}::${g.definition.symbol}` : g.groupId;
}

export function renderTriageReport(summary: RunSummary): string {
  const lines: string[] = [];

  lines.push(`# Locator triage — builds ${summary.buildsProcessed.join(', ')}`);
  lines.push('');
  lines.push(`Mode: **${summary.mode}**  ·  ${summary.startedAt} → ${summary.finishedAt}`);
  lines.push('');

  if (summary.cascadeGuardTripped) {
    lines.push('## Halted by the cascade guard');
    lines.push('');
    lines.push(
      `${summary.cascadeGuardReason}. No fixes were proposed and no pull request was opened.`,
    );
    lines.push('');
  }

  lines.push('## Funnel');
  lines.push('');
  lines.push('| Stage | Count |');
  lines.push('|---|---:|');
  lines.push(`| Failures collected | ${summary.totalFailures} |`);
  lines.push(`| With DOM/ARIA evidence | ${summary.withArtifacts} |`);
  lines.push(`| Distinct root causes | ${summary.groups.length} |`);
  lines.push(`| Fixes proposed | ${summary.proposals.filter((p) => p.verdict === 'fixable').length} |`);
  lines.push(`| Fixes verified | ${summary.verifications.filter((v) => v.passed).length} |`);
  lines.push('');

  const verified = new Set(summary.verifications.filter((v) => v.passed).map((v) => v.groupId));
  const fixedGroups = summary.groups.filter((g) => verified.has(g.groupId));

  if (fixedGroups.length > 0) {
    lines.push('## Fixed');
    lines.push('');
    lines.push('| Page object | Cause | Change | Failures | Tags |');
    lines.push('|---|---|---|---:|---:|');
    for (const g of fixedGroups) {
      const proposal = summary.proposals.find((p) => p.groupId === g.groupId);
      const cause =
        g.signature === 'strict_mode'
          ? `strict mode (${g.strictMode?.matchCount ?? '?'} matches)`
          : 'not found';
      const change = `\`${g.definition?.expression ?? '?'}\` → \`${proposal?.proposedLocator ?? '?'}\``;
      lines.push(
        `| ${short(g.definition?.filePath ?? 'unknown')} | ${cause} | ${change} | ${g.instanceCount} | ${g.affectedTags.length} |`,
      );
    }
    lines.push('');

    for (const g of fixedGroups) {
      if (!g.strictMode || g.strictMode.matches.length === 0) continue;
      lines.push(`<details><summary>${groupLabel(g)} — the ${g.strictMode.matchCount} elements that matched</summary>`);
      lines.push('');
      lines.push('```');
      for (const m of g.strictMode.matches) {
        lines.push(`${m.index}) ${m.html}${m.suggestion ? `  aka ${m.suggestion}` : ''}`);
      }
      lines.push('```');
      lines.push('');
      lines.push(`Structure read as **${g.strictMode.structure}**.`);
      lines.push('</details>');
      lines.push('');
    }

    lines.push('### Verification');
    lines.push('');
    for (const v of summary.verifications.filter((x) => x.passed)) {
      const g = summary.groups.find((x) => x.groupId === v.groupId);
      lines.push(
        `- **${g ? groupLabel(g) : v.groupId}** — ${v.scenarioPasses}/${v.scenarioRuns} scenario runs passed; ` +
          `${v.featureFilesRun.length} feature file(s) passed in full (${Math.round(v.durationMs / 1000)}s)`,
      );
    }
    lines.push('');
  }

  if (summary.notFixed.length > 0) {
    lines.push('## Not fixed — needs a human');
    lines.push('');
    for (const n of summary.notFixed) {
      const g = summary.groups.find((x) => x.groupId === n.groupId);
      lines.push(
        `- **${g ? groupLabel(g) : n.groupId}** — _${VERDICT_LABEL[n.verdict]}_. ${n.rationale} (${n.tags.length} tag${n.tags.length === 1 ? '' : 's'}: ${n.tags.join(', ')})`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderPullRequestBody(summary: RunSummary): string {
  const body = renderTriageReport(summary)
    .replace(/^# .*$/m, `## Locator fixes from builds ${summary.buildsProcessed.join(', ')}`)
    .replace(/^## Funnel[\s\S]*?\n\n(?=## )/m, '');

  return [
    body,
    '',
    '> ⚠️ Reviewer: confirm each change reflects an intended UI change. If an element',
    '> should not have changed, drop that commit and raise a defect instead of merging.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    '',
    'https://claude.ai/code/session_01H4dTb4fTR6B9C2TKUE5vTy',
  ].join('\n');
}

/** Compact console summary, for the Jenkins log. */
export function renderConsoleSummary(summary: RunSummary): string {
  const verified = summary.verifications.filter((v) => v.passed).length;
  return [
    '',
    '────────────────────────────────────────────────',
    `  Failures collected : ${summary.totalFailures}`,
    `  With evidence      : ${summary.withArtifacts}`,
    `  Root causes        : ${summary.groups.length}`,
    `  Fixes verified     : ${verified}`,
    `  Not fixed          : ${summary.notFixed.length}`,
    summary.prUrl ? `  Pull request       : ${summary.prUrl}` : '  Pull request       : (none)',
    '────────────────────────────────────────────────',
    '',
  ].join('\n');
}
