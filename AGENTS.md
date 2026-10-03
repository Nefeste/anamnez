This is an Expo/React Native mobile game (Android first). Prioritize mobile-first patterns,
smoothness on modern Android phones (no freezes; budget phones are not a target), and a pure,
deterministic game engine.

## Studio charter — read first

This project belongs to the «Горница» studio. Studio-wide rules live only in the public
charter repository `Nefeste/gornitsa` (https://github.com/Nefeste/gornitsa); this repository
keeps only what is specific to the project. Before changing anything — and after a context
reset — read the charter's `AGENTS.md`, then `docs/05-rules.md` (hard rules for every game)
and `docs/04-process.md` (how work is done). Raw files:
`https://raw.githubusercontent.com/Nefeste/gornitsa/main/<path>`.

Current state of this project: `STATUS.md` (it is not repeated here).

Precedence: the owner's recorded decision → the charter → this project's documents. A project
rule may narrow a charter rule, never weaken it. If a document here restates or contradicts
the charter, replace it with a link or report the contradiction to the owner.

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

Working rule, spec-first lifecycle, ADRs and version sections are the same in every studio
project — charter `docs/04-process.md`. In addition here: new diseases, findings and exams are
**content records**, not specs (`docs/05-content.md`).

## Medical content rules (non-negotiable)

- **Never use data, files, lists or structure from other games** — Project Hospital (including
  its installed files, "sources", mods or database), Two Point Hospital, or any other — and never
  the `data/*.json` of the old Godot `ClinicSim` repo, which mirrors Project Hospital. Not "for
  initial filling", not "just to compare". If asked to, decline and point to ADR 0008.
- Write every record **from a named primary source** (Russian Ministry of Health clinical
  guidelines, textbooks, papers, open datasets listed in `docs/05-content.md` §2) and put it in
  `sources`. Never from memory: model memory mixes sources, including other games.
- Cite a Ministry of Health guideline by its entry in the rubricator (`cr.minzdrav.gov.ru`): exact
  title, publication year, ID and card URL (`docs/05-content.md` §2). Before a release with a
  changed base run `bun tools/content/clinrecs.ts` (needs network): the guideline is in force,
  the title matches, there is no newer version.
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

## Expo and native SDKs

The Expo SDK version is in `package.json`. Never write Expo, React Native or Skia code from memory —
follow «Expo has changed» in the charter's `AGENTS.md`. Notable: `expo-av` is removed (use
`expo-audio`); Skia on web needs CanvasKit (`setup-skia-web`).

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
npm run economy-sim         # own-hospital balance: 30 days, criteria in docs/specs/2026-09-own-hospital.md (~5 min)
npm run export:web && npm run e2e   # web build + Playwright scenario, screenshots in tools/e2e/out
npm run store               # after export:web: store icon, screenshots and graphics into store/ (store/README.md)
```

Run lint, typecheck, tests and the content validator before declaring any task done; for UI
changes also the web scenario. Screens live in `src/app/` (Expo Router). On web, CanvasKit
must load before any Skia module runs — `index.web.ts` loads it and only then requires the
router; do not import Skia-dependent modules from it.

## Rules

Studio-wide hard rules — generated `ios/`/`android/`, no React Native `Alert`, player-facing strings
only in `src/i18n/` and `content/`, a permanent signing key, no generated images — are in the
charter's `docs/05-rules.md` and are not repeated here. Project rules:

- The release build has **no `INTERNET` permission** (ADR 0006); it is removed from the release
  manifest by a config plugin, debug keeps it for Metro. Any new permission must be added to the
  CI whitelist consciously.
- The app's own confirm window is `Sheet` in `src/ui/components.tsx` (instead of `Alert`).
- Colors and fonts come from the current theme (`docs/specs/2026-09-own-look.md`): screens call
  `useTheme()` and style with `makeStyles(t => …)` from `src/ui/theme.ts`. No hex, `rgb()` or
  module-level `StyleSheet.create` in `src/app` and `src/ui` outside `src/ui/palette.ts` —
  `tools/test/theme.test.ts` guards it. The hospital plan, portraits and images (`src/render`)
  keep their own colors in both themes.
- React Compiler memoizes calls by argument identity, and the engine mutates its state in place:
  screens read data from the view rebuilt per version (`ShiftView` in `src/state/session.ts`),
  never compute from the live state during render (`docs/06-architecture.md` §12).
- Store texts never mention other games, TV shows, real insurers, clinics or drug brands
  (`docs/11-publishing.md`).
