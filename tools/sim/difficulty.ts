// npm run difficulty-sim — трудность случаев (часть 92, вопрос 56, spec 2026-10-case-difficulty): доли лёгких, средних и
// трудных по больницам глав, временам года, пришедшим сами и привезённым скорой; какие болезни трудные; и подбор «Случая
// дня» — сколько зёрен и прогонов разумного врача до трудного, какие болезни выпадают. Мера — та же, что у разбора
// (`hardnessOf`): разумный врач разбора со всеми обследованиями и кандидатами отделений больницы, тем же зерном.
// Флаги: --n 400 (пациентов в каждой больнице), --days 90 (дней подбора «Случая дня»), --venue clinic|district|vascular|city.
import { db } from '../../src/content';
import { Rng } from '../../src/engine/core/rng';
import { type CaseHardness, hardnessOf, type Hardness } from '../../src/engine/med/difficulty';
import { complaintObservations } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { startRational } from '../../src/engine/med/policy';
import { reviewBeliefs } from '../../src/engine/med/review';
import type { Season } from '../../src/content/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { dailyCaseSeed, dayOf, seasonOfDay } from '../../src/state/daily';
import { DEPARTMENT } from '../../src/state/caseView';

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const N = Number(arg('n', '400'));
const DAYS = Number(arg('days', '90'));
const only = arg('venue', 'all');
/** Отделения больниц глав: амбулатория — терапия; районная — с хирургией и травмой; сосудистая — и неврология; город — и инфекции. */
const VENUES: Record<string, string[]> = {
  clinic: ['dept.therapy'],
  district: ['dept.therapy', 'dept.surgery', 'dept.trauma'],
  vascular: ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'],
  city: ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'],
};
const SEASONS: Season[] = ['winter', 'spring', 'summer', 'autumn'];
const exams = Object.keys(db.exams).sort();
const pct = (k: number, n: number) => Math.round((100 * k) / Math.max(1, n));

interface Case { h: CaseHardness; season: Season; carried: boolean; truth: string; favorite: boolean }

for (const [venue, departments] of Object.entries(VENUES)) {
  if (only !== 'all' && only !== venue) continue;
  const candidates = candidatesOf(db, departments);
  const cases: Case[] = [];
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    // каждый четвёртый в больнице — привезённый скорой; времена года — поровну и у тех, и у других
    const carried = venue !== 'clinic' && i % 4 === 3;
    const season = SEASONS[(i + Math.floor(i / 4)) % 4];
    const patient = generatePatient(db, 5_000_000 + i, { department: 'dept.therapy', departments, season, ...(carried ? { carried: db.economy.ambulance.weight } : { walkIn: true }) });
    const door = reviewBeliefs(db, patient, candidates, complaintObservations(patient));
    const r = startRational(db, patient, Rng.seeded(patient.seed).fork('review'), { candidates: [...candidates], exams: [...exams] }).result();
    const truth = patient.truth.conditions[0].id;
    cases.push({ h: hardnessOf(db, patient, candidates, door, r), season, carried, truth, favorite: door[0].id === truth });
  }
  const ms = (performance.now() - t0) / N;
  const line = (name: string, xs: Case[]) => {
    const n = xs.length;
    const of = (lv: Hardness) => pct(xs.filter(x => x.h.level === lv).length, n);
    const row = xs.reduce((a, x) => a + x.h.row, 0) / Math.max(1, n);
    return `  ${name.padEnd(8)} ${String(n).padStart(4)}: лёгких ${of('easy')} %, средних ${of('medium')} %, трудных ${of('hard')} %; в ряду у двери — ${row.toFixed(1).replace('.', ',')}; разумный врач уверен в верном — ${pct(xs.filter(x => x.h.solved).length, n)} %`;
  };
  console.log(`\n${venue} (${ms.toFixed(0)} мс на пациента)`);
  console.log(line('все', cases));
  for (const s of SEASONS) console.log(line(s, cases.filter(x => x.season === s)));
  if (venue !== 'clinic') {
    console.log(line('сами', cases.filter(x => !x.carried)));
    console.log(line('скорая', cases.filter(x => x.carried)));
  }
  const hard = cases.filter(x => x.h.level === 'hard');
  const by: Record<string, number> = {};
  for (const x of hard) by[x.truth] = (by[x.truth] ?? 0) + 1;
  console.log(`  трудные: ${Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, v]) => `${db.conditions[id].name.ru} ${v}`).join(', ')}`);
  console.log(`  из трудных правда — первая в «Похоже на» у ${hard.filter(x => x.favorite).length} из ${hard.length}; разумный врач уверен в верном — у ${pct(hard.filter(x => x.h.solved).length, hard.length)} %`);
}

// «Случай дня» (часть 92): подбор — тот же, что в игре (`dailyCaseSeed`)
if (only === 'all' && DAYS > 0) {
  const t0 = performance.now();
  const by: Record<string, number> = {};
  for (let d = 0; d < DAYS; d++) {
    const day = dayOf(new Date(2026, 9, 1 + d));
    const p = generatePatient(db, dailyCaseSeed(day), { department: DEPARTMENT, season: seasonOfDay(day) });
    by[p.truth.conditions[0].id] = (by[p.truth.conditions[0].id] ?? 0) + 1;
  }
  console.log(`\n«Случай дня», ${DAYS} дней с 01.10.2026: ${((performance.now() - t0) / DAYS).toFixed(0)} мс на подбор`);
  console.log(`  болезни: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([id, v]) => `${db.conditions[id].name.ru} ${v}`).join(', ')}`);
}
