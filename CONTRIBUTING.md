# Contributing to grok-plugin-cc

Thanks for considering a contribution. This file covers the boring stuff
(how to run tests, how to add a slash command) — please skim it before
opening a PR.

## Running tests locally

Tests use Node's built-in `node:test` runner — there are no `devDependencies`
to install.

```bash
npm test                # one-shot
npm run test:watch      # rerun on file changes
```

Tests live in `tests/*.test.mjs`. Each file uses `node:test` and
`node:assert/strict`.

## Project layout

```
.claude-plugin/marketplace.json    # marketplace metadata
plugins/grok/                      # the plugin itself
  .claude-plugin/plugin.json
  scripts/companion.mjs            # dispatcher
  scripts/session-lifecycle-hook.mjs
  scripts/stop-review-gate-hook.mjs
  scripts/lib/*.mjs                # state, args, git, process, render, verdict, prompts, grok
  commands/*.md                    # one file per slash command
  agents/grok-rescue.md            # subagent definition
  prompts/*.md                     # review + adversarial-review + stop-gate
  schemas/review-output.schema.json
  skills/<name>/SKILL.md           # internal helper skills (user-invocable: false)
  hooks/hooks.json
tests/*.test.mjs                   # unit tests
```

## Adding a slash command

1. Create `plugins/grok/commands/<name>.md` with a `---` frontmatter block
   describing `description`, `argument-hint`, and `allowed-tools`. Follow
   the existing commands for style — terse, declarative, no narration.
2. Add a `cmd<Name>` function in `plugins/grok/scripts/companion.mjs` and
   wire it into the `switch` in `main()`. The function must:
   - Call `process.exit(<code>)` for every code path (success, validation
     error, timeout, missing binary).
   - Use `grokBaseArgs({readOnly, model, jsonOutput})` for argument
     construction — do not assemble flags by hand.
   - For long-running work, route through `runJob()` so job metadata,
     timeout handling, and cleanup all stay in one place.
3. Add a test case in `tests/` that covers the happy path and at least one
   error path. Prefer testing parsing/validation purely (no subprocess
   spawning) when possible.
4. Update `README.md`'s "What you get" table and `CHANGELOG.md`'s
   "Unreleased" section.

## Adding env vars to the allowlist

`cleanGrokEnv()` in `plugins/grok/scripts/lib/grok.mjs` drops every env
var that is not on the explicit allowlist. Before adding a key:

- Verify it is documented in xAI's official Grok CLI README
  (`~/.grok/README.md`).
- Add a one-line comment in the diff explaining why the spawned `grok`
  needs that key.
- Add a unit test in `tests/grok.test.mjs` showing both that the new key
  passes through AND that a representative sensitive key (e.g.
  `ANTHROPIC_API_KEY`) is still dropped.

## Style notes

- ECMAScript modules (`.mjs`), Node 20+ syntax.
- No `devDependencies`. Tests, lint, and version bumps run on Node alone.
- Comments explain **why**, not what. If a reader can answer "what" from
  the surrounding identifiers, the comment is noise.
- Two-space indent, double-quoted strings (matches the gemini-plugin-cc
  convention this repo is derived from).

## Releasing

The version lives in three places — keep them in sync:

- `package.json` `version`
- `.claude-plugin/marketplace.json` `metadata.version` and `plugins[0].version`
- `plugins/grok/.claude-plugin/plugin.json` `version`

After bumping:

```bash
git tag v<new-version>
git push --tags
```

CI runs the tests on every push and on PRs (Node 20 + 22 on Ubuntu and
macOS).
