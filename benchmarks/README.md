# Form performance measurements

Run the headless benchmark from the repository root:

```sh
node --import tsx benchmarks/form-session.ts --output=/tmp/fieldwork-session.json
```

For mounted React measurements, build the production example and serve its output:

```sh
vp run build
vp -C examples/react preview --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173/?benchmark=massive`. The page mounts every input and supports 100, 1,000, and 5,000 fields. Each contact has 25 nested string fields with required, email, and length constraints. Each field has a full-field subscription and a resolved-required subscription; one selected-value subscription per contact and one submitting-status subscription run alongside them. The benchmark uses no virtualization.

Set the initial size and target directly with `?benchmark=massive&fields=5000&target=last`. Supported sizes are 100, 1,000, and 5,000; unsupported values use 1,000. Targets are `first` and `last`.

## What the measurements cover

The headless harness alternates one field between an edited value and its baseline. It compares first and last fields, initial and reset baselines, no listeners, value selectors, and full-field selectors. Additional cases populate every field's touched metadata. Each case records 450 edits across three rounds, with 50 warmup edits before each round. Assertions verify notification counts, changed selections, and restoration of the clean baseline.

Native generated-schema decoding and sequential submissions are measured separately. Cold submission includes the first schema compilation and execution; warm submission reuses the definition's cached schema. These timings also include runtime and allocation costs, so their difference does not isolate compilation cost.

The React page warms up with 30 edits, then records 300 updates with a forced commit after each one. Mutation time covers the session update and synchronous subscription notifications. Edit-to-commit time starts before the update and ends in the edited input's layout effect. Neither metric includes painting. Manual samples start inside real input change handlers and end at the same layout effect.

Result publication happens after sampling. Run performance workloads separately from builds, tests, and other benchmark processes. Timing distributions are measurements of the recorded environment, not pass/fail thresholds or guarantees for other devices.

## Headless results

Recorded October 7, 2026, on macOS ARM64 with an Apple M1 Max, 10 logical CPUs, and Node 26.10.0. The original rewrite measurements were isolated from repository checks and browser timings. Complete scenario summaries and environment details are in [session-before.json](results/session-before.json) and [session-after.json](results/session-after.json).

With one full-field selector per field, editing the last field after initial mount produced these costs. Metadata was pristine; each row contains 450 alternating writes.

| Fields | Edit p50  | Edit p95  | Listener calls per edit | Changed selections per edit |
| ------ | --------- | --------- | ----------------------- | --------------------------- |
| 100    | 0.232 ms  | 0.271 ms  | 100                     | 1                           |
| 1,000  | 2.544 ms  | 3.311 ms  | 1,000                   | 1                           |
| 5,000  | 13.230 ms | 15.865 ms | 5,000                   | 1                           |

The benchmark exposed two redundant copies: initial state cloned the already-owned draft and baseline separately, losing reference sharing; ordinary edits cloned the unchanged touched metadata map. Preserving those references reduced the basic edit cost below. These rows use 5,000 fields, edit the last field, and have no listeners.

| Metadata           | Before p50 / p95 | After p50 / p95  |
| ------------------ | ---------------- | ---------------- |
| Pristine           | 0.198 / 0.284 ms | 0.018 / 0.020 ms |
| All fields touched | 2.598 / 3.126 ms | 0.018 / 0.020 ms |

With all 5,000 full-field selectors and all fields touched, final edit costs were 13.937 ms p50 and 18.923 ms p95. Selector evaluation remains linear in the number of subscribers even though only one field selection changes.

For 5,000 valid fields, native decoding measured 4.624 ms p50 and 10.912 ms p95. First submission took 21.048 ms; warm cached submissions measured 6.869 ms p50 and 13.737 ms p95. The observed validation and submission tails varied between runs, so use the complete recorded summaries rather than treating cold/warm differences as an isolated cache speedup.

### After path and binding fixes

The headless harness was rerun on the same host on October 7, 2026, after the contextual numeric-path, nullable-read, sparse-array, progress, binding, and required-object fixes. It ran independently of builds and tests. [session-path-fixes.json](results/session-path-fixes.json) records all 30 edit scenarios plus validation and submission measurements. Notification and clean-baseline assertions passed.

Editing the last field with pristine metadata and one full-field selector per field measured:

| Fields | Edit p50  | Edit p95  | Listener calls per edit | Changed selections per edit |
| ------ | --------- | --------- | ----------------------- | --------------------------- |
| 100    | 0.254 ms  | 0.315 ms  | 100                     | 1                           |
| 1,000  | 2.610 ms  | 2.890 ms  | 1,000                   | 1                           |
| 5,000  | 13.841 ms | 14.402 ms | 5,000                   | 1                           |

At 5,000 fields, all-touched full-field subscriptions measured 14.189 ms p50 and 14.899 ms p95. Without listeners, pristine last-field edits measured 0.019 ms p50 and 0.019 ms p95; all-touched edits measured 0.019 ms p50 and 0.021 ms p95. The pristine subscribed median was about 5% higher than the previous run, while its p95 was lower. Subscription fanout remains linear.

For 5,000 valid fields, native decoding measured 3.485 ms p50 and 3.842 ms p95. First submission took 20.395 ms; warm submissions measured 3.674 ms p50 and 4.118 ms p95. These differences remain subject to runtime variation. Mounted React measurements were not rerun after these fixes; the results below describe the earlier production build.

### After validation and session fixes

The headless harness was rerun on the same host on October 7, 2026, after the indexed-read, root-array, tuple, submission-lifetime, native-error, conditional-rule, and sparse-row fixes. Each run was separate from repository checks. The first result is preserved in [session-review-fixes.json](results/session-review-fixes.json); [session-review-fixes-recheck.json](results/session-review-fixes-recheck.json) records the subsequent run after removing redundant per-segment syntax checks from path parsing. The complete path grammar and reserved-key checks remain enforced. All notification and clean-baseline assertions passed in both runs.

The subsequent run measured last-field edits with pristine metadata and one full-field selector per field:

| Fields | Edit p50  | Edit p95  | Listener calls per edit | Changed selections per edit |
| ------ | --------- | --------- | ----------------------- | --------------------------- |
| 100    | 0.263 ms  | 0.370 ms  | 100                     | 1                           |
| 1,000  | 2.725 ms  | 3.946 ms  | 1,000                   | 1                           |
| 5,000  | 13.963 ms | 15.043 ms | 5,000                   | 1                           |

At 5,000 fields, all-touched full-field subscriptions measured 14.862 ms p50 and 20.301 ms p95. Without listeners, pristine last-field edits measured 0.020 ms p50 and 0.063 ms p95; all-touched edits measured 0.020 ms p50 and 0.022 ms p95. The pristine subscribed median was about 1% higher than the prior path-fix measurement. Subscription fanout remains linear.

The first run measured 23.404 ms p50 and 71.080 ms p95 for the pristine 5,000-subscriber case, with wide timing distributions across scenarios. The difference between these runs does not isolate the parser change's benefit; runtime variation remains material, especially in the tails.

For 5,000 valid fields, the subsequent run measured native decoding at 4.306 ms p50 and 5.429 ms p95, first submission at 21.397 ms, and warm submission at 4.264 ms p50 and 4.854 ms p95. Mounted React timings below remain from the earlier production build and were not rerun after these fixes.

### Native Effect ownership

Recorded October 8, 2026, after native Effect atoms, refs, scopes, fibers, and deferred results replaced custom session coordination. [session-effect-native.json](results/session-effect-native.json) records the same 30 headless scenarios on the Apple M1 Max host with Node 26.10.0. Sampling ran separately from repository checks and browser workloads. Every notification, changed-selection, and clean-baseline assertion passed.

Pristine last-field edits with one full-field selector per field measured:

| Fields | Edit p50  | Edit p95  | Listener calls per edit | Changed selections per edit |
| ------ | --------- | --------- | ----------------------- | --------------------------- |
| 100    | 0.257 ms  | 0.287 ms  | 100                     | 1                           |
| 1,000  | 2.831 ms  | 3.968 ms  | 1,000                   | 1                           |
| 5,000  | 14.251 ms | 15.468 ms | 5,000                   | 1                           |

At 5,000 fields, all-touched subscriptions measured 14.643 ms p50 and 16.080 ms p95. No-listener last-field edits measured 0.021 ms p50 and 0.024 ms p95. The pristine subscribed median was about 2% higher than the preceding recheck; this difference does not isolate the cost of native ownership. Native decoding measured 6.138 ms p50 and 7.006 ms p95; first submission took 24.526 ms and warm submissions measured 6.266 ms p50 and 6.926 ms p95. Runtime variation remains material.

[react-effect-native.json](results/react-effect-native.json) records three automated mounted samples in the Codex in-app browser using the refreshed production build. Observed input counts matched each size. Each sample used 30 warmups and 300 forced commits, with exactly 300 edited field renders, one distinct rendered field, and zero unrelated field renders.

| Mounted inputs | Target | Mutation p50 / p95 | Edit-to-commit p50 / p95 |
| -------------- | ------ | ------------------ | ------------------------ |
| 1,000          | First  | 2.1 / 2.5 ms       | 2.2 / 2.7 ms             |
| 5,000          | First  | 21.9 / 23.3 ms     | 23.3 / 24.7 ms           |
| 5,000          | Last   | 22.9 / 24.0 ms     | 24.4 / 25.5 ms           |

At 5,000 inputs, all 200 contact selectors still evaluated on every edit. Render isolation remains intact, while linear notification fanout consumes more than a 16.7 ms frame budget in this browser. These samples use a different browser harness from the earlier standalone headless Chromium run below, so they do not establish a like-for-like browser regression or improvement. Painting remains excluded. No new manual-input timings are included in this recording.

## Earlier mounted production React results

Recorded on the same Apple M1 Max host using headless Chromium 154.0.8037.57 against the built production example, without React StrictMode. Browser sampling ran after the headless benchmark and independently of repository checks. [react-production.json](results/react-production.json) contains all twelve sample summaries, browser metadata, and instrumentation counts. Browser timers have approximately 0.1 ms resolution in this run.

Each automated row below records 300 updates after 30 warmups. Mutation includes session updates and synchronous subscriber notifications; commit timing also includes the edited input's React layout commit. The fields start with pristine metadata, editing does not run validation, and every input remains mounted.

| Mounted inputs | Target | Mutation p50 / p95 | Edit-to-commit p50 / p95 |
| -------------- | ------ | ------------------ | ------------------------ |
| 100            | First  | 0.2 / 0.3 ms       | 0.3 / 0.4 ms             |
| 100            | Last   | 0.2 / 0.3 ms       | 0.2 / 0.4 ms             |
| 1,000          | First  | 2.6 / 3.0 ms       | 2.9 / 3.4 ms             |
| 1,000          | Last   | 2.4 / 2.8 ms       | 2.6 / 3.2 ms             |
| 5,000          | First  | 13.7 / 14.5 ms     | 14.8 / 15.7 ms           |
| 5,000          | Last   | 13.8 / 15.0 ms     | 15.5 / 17.0 ms           |

Separate samples used 30 alternating Playwright `fill` operations per target, exercising browser input events. Timing starts in React's input change handler; it excludes the automation action, pre-handler event dispatch latency, and painting. Setup waits for the manual recorder's frame reset before entering input events.

| Mounted inputs | Target | Mutation p50 / p95 | Handler-to-commit p50 / p95 |
| -------------- | ------ | ------------------ | --------------------------- |
| 100            | First  | 0.3 / 0.4 ms       | 0.5 / 0.6 ms                |
| 100            | Last   | 0.3 / 0.4 ms       | 0.4 / 0.6 ms                |
| 1,000          | First  | 2.7 / 2.9 ms       | 3.1 / 3.3 ms                |
| 1,000          | Last   | 2.8 / 3.0 ms       | 3.2 / 3.4 ms                |
| 5,000          | First  | 13.5 / 14.9 ms     | 14.6 / 16.2 ms              |
| 5,000          | Last   | 13.4 / 14.4 ms     | 14.8 / 16.1 ms              |

All twelve samples recorded exactly one edited field render per update, one distinct rendered field, and **zero unrelated field renders**. Input-count assertions confirmed all 100, 1,000, or 5,000 inputs were mounted. The first-field edit also changed its contact's selected `field0` output once per update; last-field edits changed none of those outputs. Nevertheless, all contact selectors evaluated on every update: 200 calls per update at 5,000 inputs. This confirms that render isolation works while selector notification still scales with the number of subscriptions.

The mounted benchmark has two subscriptions per field, so its workload differs from the headless full-field-selector case. At 5,000 inputs, subscription work consumes most of a 16.7 ms frame budget before painting. These measurements support reducing subscription fanout if such large forms are a target; they do not establish painted interaction latency or a browser performance improvement over the previous implementation, for which no comparable mounted baseline was recorded.
