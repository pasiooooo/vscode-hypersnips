# Performance preview report

The performance work is isolated on `codex/performance-refactor`, based on `d851872`. The extension keeps version `0.1.4` and identity `pasiooooo.vscode-hypersnips`. The original checkout's Marketplace preparation is not part of this branch.

This is a preview for installation testing. Main has not been merged. Local automated validation does not replace the user's installation/usage confirmation. Further performance investigation remains open, particularly first-open work and large structural changes.

## Measurements

Windows, Intel Core i7-14700KF, Node v25.8.1. Frozen baseline and current algorithms run in the same process. Each group has 10 warmups and 200 timed samples. The core run uses algorithm sources at `67b13f6`; subsequent completion-only changes do not affect those algorithms. Completion measurements include `9090486`.

| Synthetic operation | Baseline median / P95 ms | Current median / P95 ms | Median reduction |
| --- | ---: | ---: | ---: |
| 1 MiB local edit, context and name-sync gate | 132.3776 / 167.7852 | 1.4467 / 1.7984 | 98.9% |
| 100 rows x 128 columns alignment | 225.2060 / 333.2504 | 19.6631 / 25.2409 | 91.3% |
| Compile 10000 snippets | 116.9546 / 957.4995 | 14.0483 / 17.8571 | 88.0% |
| Automatic matching, 10000 literal candidates | 2.1173 / 2.2710 | 0.5716 / 0.6393 | 73.0% |
| Manual matching, 10000 literal candidates | 2.1331 / 2.2127 | 1.1203 / 1.2260 | 47.5% |
| Sanitize 1140000 characters requiring no masks | 22.5156 / 48.7162 | 1.7036 / 2.0438 | 92.4% |

All three planned core gates pass: at least 70% lower local-edit median, local-edit P95 below 10 ms, and at least 50% lower wide-alignment median. Ordinary edits reparse one block and reuse 14575 blocks in the 1 MiB fixture.

First construction still costs 126.3343 ms median / 204.2661 ms P95 in the comment-heavy 1 MiB fixture. An opening Markdown fence at the beginning costs 34.3231 / 41.3863 ms. These structural/cold cases do not have a fixed-time promise.

Timings are function execution, excluding editor IPC/rendering, the existing 150 ms alignment debounce, native font process startup and other extensions. Absolute values vary with machine load; the baseline's large compilation P95 shows that variability. Shared CI checks work counts and correctness rather than absolute milliseconds.

The final core run printed its report through a read-only adapter after automatic approval of the file-writing rerun repeatedly timed out. The adapter runs the same benchmark source and redirects only report-file writes to stdout. Its values are recorded in `performance-measurements.json`.

## What changed

- Shared immutable document snapshots retain current/previous versions. Line/block checkpoints reuse parser results after edits, with distinct prefix and full-document queries. Context, Enter/Tab, name synchronization, conversion and alignment use them.
- Name synchronization gates ordinary text edits before constructing environment pairs. Context keys are sent only when their values change.
- Alignment indexes anchors by cell and accumulates widths in their original floating-point order. Scheduler eligibility is checked before merging repeated positions by environment. Fonts collect document glyphs from affected bodies; four font configurations are cached, queued glyph requests merge and stale queued work is skipped.
- Snippet parsing uses a cursor and a pending dynamic-code fragment. Reloading builds the whole replacement table before publishing it; failure leaves the prior table available. Duplicate callbacks from one profile change share work, while later operations still execute global code.
- Manager typing updates content, dirty indicators and buttons. Accepted analysis refreshes results; stale range operations and saving conflicts retain their checks.
- Automatic matching omits unused partial-prefix work. Manual suffix-prefix search skips lengths exceeding the current input. Text without masking markers avoids character-array copies.

## Verification

`npm run check` includes all original tests plus incremental, alignment, font scheduling, snippet loading/manager, completion and sanitization regressions.

- Incremental tests compare contexts, environment ranges, edits and carets at intermediate states, including 525 seeded edits, 100 seeded multi-edit batches, CRLF, Unicode, incomplete constructs, nested/custom environments, comments, fences and verbatim. The original incremental stage additionally passed an independent 9000-state every-offset review.
- Exact alignment edits/caret mappings match frozen references across fractional/extreme widths, Tabs, operators, comments, nesting and empty cells. Independent alignment review added 700 seeded fixtures. Native Windows checks validate Consolas/CJK and Arial widths and idempotent alignment.
- Font queue tests count actual mocked child launches: two same-font queued requests merge into one; stale queued work launches zero processes; four fonts are retained and an evicted fifth font is measured again. Failures and malformed results preserve fallback behavior.
- Parser tests compare metadata, generated output and thrown errors, including dynamic delimiters and global closures. VM tests execute real reload code and manager webview JavaScript, including failed reads/global/parse, recovery, profile event timing, dirty buttons, stale analysis and hash/mtime/open-dirty conflicts.
- Real isolated VS Code host tests cover dynamic placeholder updates, automatic math/text snippets, manual completion acceptance, environment name sync, Enter/Tab, actual intermediate undo/redo states, multicursors, comments, alignment/toggle/stale-document protection and 20 open/edit/close cycles. They await each document's closed state.

The independent whole-branch review of d851872..e0bb68e completed with no actionable regression found. It reran seven focused suites and added 10000 parser inputs, 10000 sanitization inputs, 5000 completion contexts and adversarial loader/profile probes. Tasks 1-3 pass the code review; Task 4 remains incomplete while Windows native-font CI fails. User installed-VSIX confirmation remains required before main integration.

## Memory and limitations

After 20 warmup cycles and 100 construct/edit/release cycles, post-GC heap was 46856752 bytes before and 46742408 after. The five batch values were 46827824, 46751608, 46752184, 46742536 and 46742408. This shows a flat trend for this synthetic run, not proof that every leak is absent.

Updates still copy text and rebuild the block-offset index. Large unfinished multiline constructs share a block; first pair/sanitized-text queries can visit the whole document. These are remaining profiling candidates, so the broader optimization goal is not declared complete.

Font measurement remains a one-shot asynchronous Windows process. Non-Windows hosts retain Unicode-width fallback. A fixed ASCII alphabet is still warmed in addition to characters collected from affected bodies; removing that warmup requires comparing later process counts and alignment latency. Already-running processes finish normally, with stale results prevented from editing a newer document.

Arbitrary user regular expressions and JavaScript retain their original execution semantics and can take unbounded time. Failure to publish a new snippet table cannot undo side effects already performed by a user's global code.

## Installation and merge gate

Follow `performance-testing.md` for installation, window reload, rollback and the manual checklist. Install the VSIX whose filename includes the commit hash; the UI version remains 0.1.4. Reinstall the original 0.1.4 VSIX to roll back, then reload the window.

The performance-branch CI runs Windows/Linux regression and real-host checks and creates a preview artifact. It does not create a release tag or publish to GitHub Releases/Marketplace. Remote run 39957359978: Linux regression and extension-host job passed; Windows failed the strict native font measurement assertion (space width undefined instead of 1), so remote packaging was skipped. The locally built 4a12df8 VSIX was inspected: 57 entries, correct identity/settings, incremental module present, no development directories or temporary diagnostics. This preview is not yet fully CI-accepted.

Do not merge main before installation confirmation and remaining review gates. After confirmation, integrate the latest main into the performance branch, rerun checks, and use a merge preserving the staged commits. Behavior-changing integration requires another preview.

## Pending measured opportunity

A read-only CPU profile attributes the largest cold-parse share to sanitization. A comment-only candidate preserved every-prefix sanitization/context behavior for 300 seeded fixtures and explicit masks. In a separate 200-sample 1MiB comment-heavy sanitization probe, median 19.3233ms fell to 5.9009ms and P95 25.5003ms to 7.9759ms. It is prepared under dist/performance-staging but is NOT included in the 4a12df8 VSIX. Applying its regression test and adding Windows failure diagnostics are currently blocked by repeated automatic-approval timeouts for worktree writes.

## Latest validation

Commit 4a12df8 adds a comment-aware sanitization fast path, retains the existing masking path for Markdown/HTML/backtick input, raises the native Windows measurement timeout to 15 seconds, and adds failure-only CI diagnostics. The remote run for commit 4a12df8 passed both Linux and Windows checks, extension-host suites, and preview packaging; only the release job was skipped because this is not a tag. The latest local VSIX is dist/performance/vscode-hypersnips-0.1.4-perf.4a12df8.vsix (SHA256 C2332B620D9B3F4A7FD4FE8C2A773FEF6E2C2EF8DE9656DAA6BA9C644B69117E).

## Latest core benchmark (4a12df8 source)

The final local run used 10 warmups and 200 samples per case on the same Windows machine. All three gates passed again. The 1 MiB typing baseline/current medians were 61.8044 / 0.7143 ms (current P95 1.3282 ms, 98.8% reduction). Wide alignment was 116.5894 / 9.9803 ms (91.4% reduction). Cold 1 MiB parse was 29.0068 ms median / 34.1484 ms P95, down from the pre-comment-fast-path 126.3343 / 204.2661 ms measurement. Structural fence insertion was 17.0945 / 19.8434 ms. The complete machine-readable output is docs/performance-results-4a12df8.json.
