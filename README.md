# Fast static site — make.fun bounty `site-generator-speed-01-run-20261122`

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mrfriedo1603/makefun-static-site-22nov-2026/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mrfriedo1603/makefun-static-site-22nov-2026/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own `makefun-site` 1.0.0. For every case's input,
`solve.js` returns exactly the output tree `makefun-site`'s `build` returns — every
page, index and tag page, `build-report.txt` and static file, byte for byte — and
`main.ts` (the kit's driver, kept as the kit instructs) answers each case with it.

Bounty page: https://make.fun/bounty/site-generator-speed-01-run-20261122
Kit: https://make.fun/c/site-generator-speed-01-run-20261122/kit

## Files

- `solve.js` — the entrypoint: an ES module exporting `run(input)`. A from-scratch,
  dependency-free reimplementation of the `makefun-site` pipeline (front matter,
  Markdown subset, template dialect, slug rule, permalinks, collections, tags,
  layouts, report), written for speed: cached ASCII fast-path slugify, single-pass
  HTML escaping, run-accumulating Markdown inline rendering, first-character
  dispatch lexing, manual front-matter scanning, and scope-chain template
  rendering. No network, no clock, no randomness, no file access, and nothing
  cached from one case to the next — every cache is created inside `run()`.
- `main.ts` — the kit's driver: reads `/input/cases.json`, answers each case alone
  with `run`, writes `/output/answers.json`. Turns V8 incremental marking off
  before importing `solve.js`, as the house baseline does.
- `package.json` — `{"type": "module"}` so `solve.js` loads as an ES module.
- `LICENSE` — MIT.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## Grade it (kit, no Docker needed)

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Local test (practice set)

Against the kit's practice set (3 cases, `g-0001`–`g-0003`):

- `node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree`:
  **passed 1, 3 of 3 cases, 3 of 3 points; L1 regrade reproduced byte for byte;
  eligible: ranked yes, prize yes.**
- Two direct runs produce byte-identical `answers.json`.
- CPU time (user+sys, Node v24.22.1 on this VM, 3 runs each): this entry
  **~1.22 s** per run (1.26 / 1.14 / 1.25 s); house baseline
  (`baselines/makefun-site/`) **~1.89 s** (1.90 / 2.08 / 1.69 s); a do-nothing
  entry on the same driver costs ~0.32 s. Net of that control: **~0.90 s vs
  ~1.57 s — about 43% faster than the baseline**, comfortably beyond the noise
  between runs. (The scored set is drawn after entries close, so this is the
  practice set only; the entry must still beat the baseline on the scored set
  at 95% confidence in the final heat.)
