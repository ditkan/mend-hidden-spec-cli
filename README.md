# mend

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ditkan/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ditkan/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format. It applies an edit that an AI
model wrote to a tree of text files, in any of four formats — a unified diff
(often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON — and changes every file or none.

It finds the lines an edit names even when the model drifted their whitespace
or indentation (three matching tiers, with re-indentation at the loosest), and
reports exactly what changed or why an edit failed. Node 22, standard library
only, deterministic: no time, randomness, or network.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the path of the patch file, relative to the working directory (the
root of the tree); when it is absent or `-`, the patch is read from standard
input. Options:

- `--format=NAME` — read the patch in one format: `unified`,
  `search-replace`, `v4a`, or `json`; `auto` (the default) detects it.
- `--check` — do everything but write: same output and exit code, no file is
  created, changed, or deleted.
- `--strict` — match lines exactly (tier 0 only).

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new`)
and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed
edit and `failed: <k> of <n> edits`, and writes nothing. Exit 2 is a usage,
missing-patch, format, or parse error. See `SPEC.md` in the kit for the full
contract (the specification is the whole contract).
