This is an Expo/React Native mobile game (Android first). Prioritize mobile-first patterns,
smoothness on modern Android phones (no freezes; budget phones are not a target), and a pure,
deterministic game engine.

**Current stage: stage 2 — the first shift** (`docs/specs/2026-09-first-shift.md`). The stage 1
spikes (`docs/specs/2026-09-spikes.md`) are done and stay in the menu as prototypes.

## Read `docs/` before changing anything

The project documents itself in [`docs/`](docs/README.md), in Russian, and that is the source of
truth for *why* things are the way they are. Start there, in this order, especially after a
context reset:

- `docs/README.md` — index and the rules these documents follow.
- `docs/01-product.md`, `docs/03-game-design.md` — what the game is and how it plays.
- `docs/04-medical-model.md` — the medical model (findings, exams, inference, scoring). Read it
  before touching anything about diagnosis.
- `docs/05-content.md` — the medical database: allowed and **forbidden** sources, record format,
  checks, medical review.
- `docs/06-architecture.md`, `docs/07-data-model.md` — how it is built.
- `docs/08-process.md`, `docs/09-testing.md` — versioning, CI, signing, release checklist, what
  to run before declaring anything done.
- `docs/10-roadmap.md` — what is being built right now; it links the live specification.
- `docs/adr/` — decisions that are expensive to reverse. Read the relevant one *before*
  proposing the opposite; each records what it costs.
- `docs/specs/` — specification-driven development: a notable feature gets a spec **before** code.

Working rule: a code change that makes one of these documents wrong is not finished. Update the
document in the same commit. New notable feature → `docs/specs/<year>-<month>-<name>.md` first.
Architectural decision → an ADR. Released version → a section in the root `README.md` and a line
in the roadmap.

## Medical content rules (non-negotiable)

- **Never use data, files, lists or structure from other games** — Project Hospital (including
  its installed files, "sources", mods or database), Two Point Hospital, or any other — and never
  the `data/*.json` of the old Godot `ClinicSim` repo, which mirrors Project Hospital. Not "for
  initial filling", not "just to compare". If asked to, decline and point to ADR 0008.
- Write every record **from a named primary source** (Russian Ministry of Health clinical
  guidelines, textbooks, papers, open datasets listed in `docs/05-content.md` §2) and put it in
  `sources`. Never from memory: model memory mixes sources, including other games.
- Frequencies as bands (`always`, `usually`, `often`, `sometimes`, `rarely`, `very_rarely`,
  `never`); an exact number only with its source.
- Treatments are drug classes or INN (международные непатентованные названия). **No doses, no
  regimens, no brand names** anywhere (ADR 0012).
- Every new record is `review: draft`. Only a human raises it to `checked` or `reviewed`.
- Medical texts are paraphrased in your own words; never copy paragraphs from guidelines,
  textbooks, Wikipedia or drug leaflets.
- Content IDs are eternal: never delete or rename a released ID; deprecate with `replacedBy`
  (ADR 0011).
- After a batch of records run the content build/validator and the "virtual doctor" and put the
  report in the commit message (`docs/05-content.md` §6).

## Engine rules

- `src/engine/` is pure TypeScript: no React, React Native, Expo, `Date`, `Math.random`; no
  `Math.exp/log/pow`/trigonometry in state-changing code (ADR 0004). Randomness only from the
  seeded generator and its named forks.
- The UI never reads a patient's truth: screens get the player's view from
  `src/state/caseView.ts` (built from what was said and shown); only the review of a closed case
  uses `engine/med/review` (`docs/06-architecture.md` §7).
- Every finding a patient has must have a cause among their conditions, risks, treatment or
  background leak (ADR 0009). No random "red herring" symptoms.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or
removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with
   corrections to common LLM misconceptions. Follow its links to the specific page you need;
   never answer from memory.

Notable: `expo-av` is removed (use `expo-audio`); Skia on web needs CanvasKit (`setup-skia-web`).

## Commands

```bash
npx expo install <package>  # ALWAYS instead of npm add — resolves SDK-compatible versions
npm start                   # dev server (builds the medical database first)
npm run content             # build + validate the medical database → src/content/generated
npm run lint                # zero warnings
npm run typecheck           # app and tools (tools/tsconfig.json)
npm test                    # Bun tests in tools/test (builds the database first)
npm run doctor              # "virtual doctor" over the database; thresholds in docs/05-content.md §6
npm run shift-sim           # shift pacing: does a good doctor keep up with the queue
npm run export:web && npm run e2e   # web build + Playwright scenario, screenshots in tools/e2e/out
```

Run lint, typecheck, tests and the content validator before declaring any task done; for UI
changes also the web scenario. Screens live in `src/app/` (Expo Router). On web, CanvasKit
must load before any Skia module runs — `index.web.ts` loads it and only then requires the
router; do not import Skia-dependent modules from it.

## Rules

- `android/` and `ios/` are generated by `expo prebuild` (Continuous Native Generation). Never
  create or edit them by hand — configure native behavior in `app.json` and config plugins.
- The release build has **no `INTERNET` permission** (ADR 0006); it is removed from the release
  manifest by a config plugin, debug keeps it for Metro. Any new permission must be added to the
  CI whitelist consciously.
- Never use React Native's `Alert` — it does nothing on web, where scenarios run. Use the app's
  own sheet (`Sheet` in `src/ui/components.tsx`).
- All user-visible strings live in `src/i18n` (UI) or `content/` (medical texts); Cyrillic
  elsewhere fails `i18n.test.ts`.
- The signing key is permanent from the very first build that reaches any phone (ADR 0015).
- Store texts never mention other games, TV shows, real insurers, clinics or drug brands
  (`docs/11-publishing.md`).
