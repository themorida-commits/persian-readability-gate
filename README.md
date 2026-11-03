# Persian Readability Gate

An automated readability QA gate for Persian (Farsi) / RTL text in
[HyperFrames](https://github.com/heygen-com/hyperframes) compositions.

Instead of guessing timings from animation source code with regexes, the gate
**runs the real timeline** in a headless browser, seeks through it, and samples
every **50 ms** over the Chrome DevTools Protocol (CDP). Any authoring pattern —
`tl.add`, nested timelines, labels, `from` / `fromTo` / `to` — is measured
exactly as it renders.

For every Persian text leaf element, each sample records effective opacity
(including ancestors), the rendered text centre and width (via `Range`
rects), and motion speed. An element counts as **settled** when
opacity ≥ 0.98, centre speed ≤ 40 px/s, and scale change ≤ 0.8% per sample.
The rate-of-change definition (not distance from the final value) means a slow,
deliberate camera drift does not make settled text look "unsettled", while
entrances and overshoots still do.

- Zero dependencies. Node.js only; the browser is the Chrome Headless Shell
  from the HyperFrames cache (or `CHROME_PATH` / `HYPERFRAMES_BROWSER_PATH`,
  or a system Chromium as fallback).
- Fully offline. No API keys, no data leaves the machine.
- Runtime: ~5 s for a 6-second clip.

Persian documentation: [README-fa.md](README-fa.md) ·
Calibration report (Persian): [CALIBRATION-fa.md](CALIBRATION-fa.md)

## Usage

```bash
node gate/fa_readability_gate.mjs clip              # or a path to any index.html
node gate/fa_readability_gate.mjs clip --json out.json --spw 0.50 --floor 1.0 --dt 0.05
bash tests/run_tests.sh                             # good / broken / R8-regression tests
```

| Option | Default | Meaning |
|---|---|---|
| `--spw` | `0.50` | Seconds of settled hold required per word (rule R1) |
| `--floor` | `1.0` | Minimum settled hold for any text, in seconds |
| `--dt` | `0.05` | Sampling step, in seconds |
| `--font` | `vazirmatn` | Required font family for Persian text (rule R3) |
| `--json` | — | Write a JSON report |
| `--no-hamneshin` | — | Disable the optional brand profile (rule R6) |

Exit codes: `0` = pass, `1` = fail (violations found), `2` = infrastructure
error (no browser, no timeline, missing file).

## Rules

| Code | Rule | Default |
|---|---|---|
| R1 | Settled hold of every Persian text ≥ `max(floor, words × secPerWord)` | floor 1.0 s, 0.50 s/word |
| R2 | `letter-spacing` on Persian text is forbidden — it breaks letter joining | — |
| R3 | Persian text must use the configured font (Vazirmatn by default) | `--font` |
| R4 | Persian text blocks must have `direction: rtl` | — |
| R5 | A space instead of a ZWNJ in common patterns (`می شود` for `می‌شود`) is an error | — |
| R6 | **Optional brand profile** (warning only): text centre should sit in the top third of the frame. This encodes one project's locked layout sheet; disable with `--no-hamneshin` | on, warning |
| R7 | (Auxiliary, static) linear easing (`"none"` / `"linear"`) is forbidden unless the line carries a `gate-allow-linear` comment | — |
| R8 | Rendered text width ≤ 96% of frame width (safe margin). Measured with Range rects — `scrollWidth` is unreliable for centred RTL text | — |

Word counting: split on spaces; ZWNJ-joined compounds count as one word.

## Calibration — stated honestly

The R1 coefficient of **0.50 s/word was calibrated on 2026-11-03 on real
production clips**: 3 real compositions, 37 text elements (18 multi-word).
The tightest real holds measured 0.62–0.64 s/word (median 0.96), and every
real point passes at 0.50. The previous value (0.42) was an uncalibrated v1
heuristic. Raw gate outputs are in `calibration/`, analysis in
[CALIBRATION-fa.md](CALIBRATION-fa.md).

**No viewer study has been run yet.** The calibration is against real rendered
output, not against measured audience reading performance. Treat 0.50 s/word
as an evidence-informed starting point, not a validated readability standard.

Known measurement tolerances: settle detection with `back.out` entrances has
~0.15–0.3 s tolerance (the browser clamps overshoot opacity). Leave a safety
margin for values near the threshold. WCAG contrast is *not* re-checked by
this gate — run `hyperframes check` alongside it.

## Repository layout

- `gate/fa_readability_gate.mjs` — the gate itself (Node, zero dependencies)
- `clip/` — a 6-second 1080×1920 test composition (local Vazirmatn fonts,
  vendored GSAP) that passes the gate
- `tests/clip-broken/` — the same clip with 4 planted violations
- `tests/run_tests.sh` — three tests: good clip passes, broken clip fails with
  exactly its 4 planted violations, and an 88 px-title variant fails on R8 only
- `renders/` — sample gate JSON outputs and preview frames for both clips
  (the rendered video is not included in this release)
- `calibration/` — raw gate JSON outputs from the calibration run

## Limitations (v1)

- Text inside SVG `<text>` elements, and CSS `@keyframes` animations outside
  `window.__timelines`, are not fully covered.
- R5 catches frequent `می/نمی + verb` patterns only; it is not a complete
  ZWNJ proofreader.
- R6 is a warning, not an error, and reflects one brand's layout sheet —
  most users will want `--no-hamneshin` or their own profile.
- Compositions whose clips are windowed by the HyperFrames runtime
  (`data-start` / `data-duration` tracks) are measured against the raw
  timeline; see the calibration report for the window-correction discussion.

## Origin

This gate was built for a Persian-language product's motion-graphics pipeline
after evaluating an existing motion harness whose regex-based checker only
recognised literal `tl.fromTo`/`tl.to` calls and silently passed almost
everything on real-world timeline code. The quantified "readability law" idea
comes from that evaluation; the measurement engine here is an original
implementation.

## License

MIT — see [LICENSE](LICENSE). The bundled Vazirmatn font files in the test
clips are distributed under the SIL Open Font License by their author;
GSAP is vendored under its standard license terms for the test compositions.
