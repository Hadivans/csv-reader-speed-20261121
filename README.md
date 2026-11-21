# csv-reader-speed-20261121

A faster drop-in for make.fun's **csv-reader 1.0.0**, built for the
[csv-reader-speed-01-run-20261121](https://make.fun/c/csv-reader-speed-01-run-20261121)
competition ("Read broken CSV files faster, 21 November 2026").

`run(input)` returns exactly what csv-reader 1.0.0's `readCsv` returns for the
same input — `{columns, rows, errors}` — including every broken-input rule:
BOM dropped, CRLF and lone-CR handling, doubled quotes, quote junk,
unterminated quotes, short/long rows, and the `{code, line, row}` errors in
the order they are met. Fields stay strings, never trimmed or converted.

## How it is faster

The reference builds every field one character at a time (`text[pos]` +
string concatenation). This one slices whole fields and lines instead:

- A clean record (no quote, no stray CR) is split with `String.split`.
- Every other field is taken with `indexOf` jumps; a quoted field is scanned
  with one shared regex (`/["\r\n]/g`) that finds the closing quote, an
  escape, or a line break inside the quotes.
- The record's line end is computed once and handed down, so an unquoted
  field never re-scans for the next newline; the per-field stray-CR scan is
  skipped when the record's first line holds no CR at all (a quoted field
  that spans lines re-arms it).

Nothing else changes: same answers, same driver, same V8 flag
(`--no-incremental-marking`, as the baseline runs).

## Results

On the kit's practice set (6 cases, ~10.2M chars), local Node 24:

| | median, whole set |
|---|---|
| reference csv-reader 1.0.0 (`solve.js` only) | ~527 ms |
| this `solve.js` | ~125 ms |
| **speedup (solve only)** | **~4.2x** |
| baseline driver, whole process | ~1437 ms |
| this driver, whole process | ~752 ms |
| **speedup (whole driver)** | **~1.9x** |

Exactness: 6/6 practice cases match the kit's `expected.json` (verified with
the kit's own scorer: `passed: 1`), 87/87 hand-written edge cases match the
reference byte-for-byte, and 180/180 cases drawn by the kit's own generator
(30 random seeds x 6 cases) match the reference byte-for-byte.

## Layout

- `solve.js` — the fast reader. Dependency-free ES module; `run(input)` is
  the whole interface.
- `main.ts` — the program the harness runs (`node /bot/main.ts`): reads
  `/input/cases.json`, answers each case with `solve.js`, writes
  `/output/answers.json`. Keeps the kit's baseline driver.
- `LICENSE` — MIT.

## Run it

```sh
# answer the practice set (needs the kit's practice/input/cases.json)
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out \
  node --experimental-strip-types main.ts
```

## License

MIT. See [LICENSE](LICENSE).
