# Locator Repair Agent

Triages Playwright/Cucumber test failures, proposes locator fixes, **verifies them by
re-running the tests**, and opens a single pull request for a human to review.

It never patches selectors at runtime. Runtime self-healing silently masks real UI
regressions, which is the opposite of what a test suite is for. Every change is a
reviewable, auditable, revertible commit.

---

## How it works

```
1. COLLECT   read failure artifacts from the Jenkins EFS tree
2. CLASSIFY  decide what each failure actually is
3. GROUP     collapse many failures into distinct broken locators
4. PROPOSE   Playwright's own suggestion first, then Bedrock
5. PATCH     AST edit, page objects only
6. VERIFY    re-run the affected scenarios; discard anything that fails
7. PR        one branch, one commit per fix, one pull request
```

No database. No status polling. No stored history. No learning loop. The job reads
files, thinks once, edits code, runs tests, opens a PR, and forgets everything.

### Classification without traces

The framework uses extended chai assertions rather than Playwright's auto-retrying
`expect`, so a broken locator usually surfaces as `expected null to equal 'Sign In'`
rather than a locator timeout. Telling those apart normally needs a Playwright trace.

It does not have to. The DOM captured at the moment of failure is the evidence —
re-query the locator against it:

| Result | Meaning | Action |
|---|---|---|
| 0 matches | Locator is broken | Candidate for repair |
| 1+ matches | Locator resolves; the *value* was wrong | Real test failure, untouched |
| N matches (strict mode) | Selector under-specified | Candidate for narrowing |

Playwright driver errors are handled by signature. Two of them are **not** locator
breaks despite looking like one:

- `element is not attached to the DOM` — a re-render race. The honest fix is a wait,
  which the agent never changes.
- `Target closed` — the browser died, so no DOM was captured. Self-limiting.

### Strict mode violations

The most common failure signature in this suite, and the one where a wrong fix
actively hides bugs. Handled in [`src/strictmode.ts`](src/strictmode.ts).

**Playwright often hands you the answer.** Its strict mode errors include suggested
locators (`aka getByRole('link', { name: 'Help Desk' })`). Those are tested against
the captured DOM first; if one resolves to exactly one element, no model call happens
at all.

The structure of the matches decides whether a fix is appropriate:

| Matches look like | Reading | Action |
|---|---|---|
| Siblings in a repeating structure | Under-specified selector | Narrow it |
| Different tags or regions | Selector too broad | Scope it |
| Identical, nothing distinguishing them | Duplicate render — an app bug | **Report, do not fix** |
| One or more `aria-hidden` | Stale element left mounted | **Report, do not fix** |

`.first()`, `.last()` and `.nth()` are banned outright. Index-based selection is how a
duplicate-render bug gets quietly papered over.

---

## The four rules

Enforced in code, covered by [`test/policy.test.ts`](test/policy.test.ts). A failure
there means the agent could make a change it should not.

1. **Only fix when an equivalent element still exists** — same ARIA role and
   accessible name, somewhere in the captured DOM. Nothing equivalent means the
   feature is broken, not the selector.
2. **Never open a PR for an unverified fix.** The patched scenario must pass a real
   re-run first. This also gives staleness handling for free: if the environment moved
   or someone already fixed the break, verification fails and nothing opens.
3. **Only edit page objects.** Never `.feature` files (product-owned specification),
   never step definitions, hooks, assertion helpers, timeouts or waits.
4. **A human merges.** Enforce this with the token's scope, not just this code.

---

## Setup

### 1. Framework change (do this first)

Copy [`docs/hooks-snippet.ts`](docs/hooks-snippet.ts) into your `src/support/hooks.ts`.
It writes `dom.html`, `aria.yaml` and `failure.json` next to the screenshot and HAR you
already capture.

This is the only change needed in the test framework, and it is the longest-lead item:
**existing builds cannot be retro-fitted**, so the agent only works on runs executed
after it ships. Ship it before anything else, even though it delivers nothing alone.

### 2. Configure

```bash
cp config/default.json config/local.json   # then replace the <PLACEHOLDERS>
```

| Key | Meaning |
|---|---|
| `efsRoot` | Jenkins jobs tree. Resolve via `JENKINS_HOME`, do not hardcode a backup-restore path |
| `failureGlobs` | Where `failure.json` lands, relative to `efsRoot`. `{build}` is substituted |
| `repoRoot` | Test framework repository |
| `pageObjectDir` | The **only** writable directory |
| `verifyCommand` | How to run one scenario; `{target}` becomes `file:line` |
| `bedrockModelId` | Confirm with `aws bedrock list-foundation-models` |

### 3. Credentials

- **AWS** — the EC2 instance profile. No static keys.
- **GitHub** — `GITHUB_TOKEN` with `contents:write` and `pull_requests:write`.
  It must **not** be able to merge.

---

## Usage

```bash
npm ci && npm run build

# Report only — changes nothing. Start here and stay a while.
node dist/index.js --builds 1482,1483 --mode report-only --out report.md

# Full run: patch, verify, open one PR.
node dist/index.js --builds 1482,1483 --mode propose-pr

# Everything except the PR, leaving patches in the working tree.
node dist/index.js --builds 1482 --mode propose-pr --dry-run
```

| Flag | Default | |
|---|---|---|
| `-b, --builds` | required | Comma-separated build numbers |
| `-m, --mode` | `report-only` | `report-only` \| `propose-pr` |
| `--efs-root` | config | Override the EFS root |
| `--repo-root` | cwd | Override the framework repo |
| `-c, --config` | `config/default.json` | Config file |
| `-o, --out` | – | Write the Markdown report here |
| `--dry-run` | false | Skip branch and PR creation |
| `--log-level` | `info` | `debug` \| `info` \| `warn` \| `error` |

In Jenkins, use the [`Jenkinsfile`](Jenkinsfile) — a manually triggered parameterised
job. Put the **parameter page** URL in your summary email
(`/job/locator-repair-triage/build?delay=0sec`), not `buildWithParameters`: Jenkins
requires POST for the latter under CSRF protection, so a GET link from an email is
rejected. The parameter page also gives you a human confirmation step.

---

## Development

```bash
npm run typecheck
npm run lint
npm test
```

| Module | Responsibility |
|---|---|
| `collect.ts` | EFS walk, `failure.json` and Cucumber JSON parsing |
| `locator.ts` | ts-morph page object index; error → source line |
| `dom.ts` | Locator re-query, role/name equivalence, HAR check |
| `strictmode.ts` | Strict mode parsing and structural analysis |
| `classify.ts` | Signature table, verdicts, grouping, cascade guard |
| `propose.ts` | Playwright suggestions, then Bedrock |
| `patch.ts` | AST edits with the write-path allowlist |
| `verify.ts` | Scenario re-runs |
| `pr.ts` | Branch, per-fix commits, one PR |
| `report.ts` | Markdown for the email and the PR body |

---

## Notes

**Grouping is what makes this cheap.** Failures are grouped by
`<pageObjectFile>::<symbol>` — the exact line a fix would edit. Two failures share a
root cause if and only if one edit fixes both. A login break failing 25 tags is *one*
group and *one* model call, not 25.

**The cascade guard.** When most tags fail at once, the cause is almost never many
separate locator breaks — it is the environment. The guard trips before any model call
and opens nothing.

**Run in `report-only` for a couple of weeks first.** Stories 1–3 of this pipeline work
with no AI at all, and the failures-to-groups ratio on your real data tells you whether
the premise holds before you spend anything on inference.
