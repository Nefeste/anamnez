// Язвенная болезнь и гастрит с H. pylori (spec 2026-10-chapter-4, часть 53б): боль под ложечкой у пришедшего в
// амбулаторию — язва (277_2), гастрит, ассоциированный с H. pylori (708_2), функциональная диспепсия или рефлюкс. Их
// различают тест на H. pylori и ЭГДС; при H. pylori — эрадикация, НПВП — отменить. Без эндоскопии — «найди и лечи»
// по тесту, язву от гастрита отличают по рассказу.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const PUD = 'cond.peptic_ulcer';
const HPG = 'cond.gastritis_hp';
const FD = 'cond.dyspepsia_functional';
const GERD = 'cond.gerd';
const UB = 'cond.ulcer_bleeding';
const ERAD = 'tx.hp_eradication';
const STOP = 'tx.stop_nsaid';
const HP = 'lab.h_pylori';
const TH = ['dept.therapy'];

const patient = (primary: Id, seed: number, params: Record<string, string> = {}): Patient =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: TH, season: 'autumn', primary, params });
const people = (primary: Id, n: number, from: number) => Array.from({ length: n }, (_, i) => patient(primary, from + i));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const params = (p: Patient) => p.truth.conditions[0].params;

describe('записи по рекомендациям', () => {
  test('язвенная болезнь — амбулаторно, по 277_2; подтверждает ЭГДС; гастрит — по 708_2, подтверждают тест на H. pylori и ЭГДС', () => {
    expect(db.conditions[PUD]).toMatchObject({ icd10: 'K26.7', department: 'dept.therapy', group: 'grp.acid_dyspepsia', confirm: ['exam.egd'], params: { hp: { yes: 76, no: 24 } } });
    expect(db.conditions[PUD].derived).toEqual({ nsaid: { has: 'hx.nsaid_use' } });
    expect(db.conditions[HPG]).toMatchObject({ icd10: 'K29.5', department: 'dept.therapy', group: 'grp.acid_dyspepsia', confirm: ['exam.hp_stool', 'exam.egd'] });
    for (const id of [FD, GERD]) expect(db.conditions[id].group).toBe('grp.acid_dyspepsia');
    expect(db.conditions[PUD].sources.map(s => s.url)).toEqual(['https://cr.minzdrav.gov.ru/view-cr/277_2']);
    expect(db.conditions[HPG].sources.map(s => s.url)).toEqual(['https://cr.minzdrav.gov.ru/view-cr/708_2']);
  });

  test('тест на H. pylori: антиген в кале на иммунохимическом анализаторе — 83 и 90 %; при ЭГДС — быстрый уреазный тест, 90 и 97 %', () => {
    expect(db.exams['exam.hp_stool']).toMatchObject({ kind: 'lab', room: 'room.lab', equipment: ['eq.immuno_analyzer'], collect: 'room.procedure' });
    expect(db.exams['exam.hp_stool'].checks).toEqual([{ f: HP, sens: 8300, spec: 9000 }]);
    const egd = Object.fromEntries(db.exams['exam.egd'].checks.map(c => [c.f, [c.sens, c.spec]]));
    expect(egd[HP]).toEqual([9000, 9700]);
    expect(egd['img.egd_gastritis']).toEqual([8000, 9500]);
    // антиген в кале — в каждой больнице игры: иммунохимический анализатор есть в лаборатории амбулатории
    for (const preset of ['preset.clinic', 'preset.district', 'preset.vascular']) {
      expect(db.presets[preset].rooms.some(r => r.type === 'room.lab' && (r.equipment ?? []).includes('eq.immuno_analyzer'))).toBe(true);
    }
  });
});

describe('язвенная болезнь', () => {
  const ps = people(PUD, 600, 53_100);

  test('H. pylori — у трёх из четырёх, у остальных чаще НПВП; голодные и ночные боли — обычно; на ЭГДС — язва у каждого', () => {
    near(share(ps, p => params(p).hp === 'yes'), 0.76, 0.05);
    for (const p of ps) {
      expect(has(p, 'img.egd_ulcer')).toBe(true);
      expect(has(p, HP)).toBe(params(p).hp === 'yes');
    }
    // боль под ложечкой — почти у каждого: пропущенная у одного из двадцати — то голодная
    expect(share(ps, p => has(p, 'sym.epigastric_pain') || has(p, 'sym.hunger_pain'))).toBeGreaterThan(0.97);
    const noHp = ps.filter(p => params(p).hp === 'no');
    expect(share(noHp, p => has(p, 'hx.nsaid_use'))).toBeGreaterThan(0.65);
    near(share(ps, p => has(p, 'sym.hunger_pain')), 0.75, 0.08);
    // производный параметр — по признаку: принимает НПВП — «yes»
    for (const p of ps) expect(params(p).nsaid).toBe(has(p, 'hx.nsaid_use') ? 'yes' : 'no');
  });

  test('тактика: ИПН — первая линия; при H. pylori эрадикация обязательна, без него не нужна; НПВП — вред, принимает — отменить', () => {
    expect(txRole(db, PUD, 'tx.ppi', { hp: 'yes', nsaid: 'no' })).toBe('firstLine');
    expect(txRole(db, PUD, ERAD, { hp: 'yes', nsaid: 'no' })).toBe('require');
    expect(txRole(db, PUD, ERAD, { hp: 'no', nsaid: 'yes' })).toBe('notIndicated');
    expect(txRole(db, PUD, STOP, { hp: 'no', nsaid: 'yes' })).toBe('require');
    expect(txRole(db, PUD, STOP, { hp: 'yes', nsaid: 'no' })).toBe('notIndicated');
    for (const tx of ['tx.ibuprofen', 'tx.aspirin_course']) expect(txRole(db, PUD, tx, { hp: 'yes', nsaid: 'no' })).toBe('harmful');
    // одним антибиотиком H. pylori не лечат
    for (const tx of ['tx.amoxicillin', 'tx.macrolide', 'tx.metronidazole']) expect(txRole(db, PUD, tx, { hp: 'yes', nsaid: 'no' })).toBe('notIndicated');
    expect(db.conditions[PUD].treatment!.setting.default).toBe('home');
  });

  test('разбор: без эрадикации при H. pylori и без отмены НПВП лечение неполное', () => {
    const hp = ps.find(p => params(p).hp === 'yes' && params(p).nsaid === 'no')!;
    const nsaid = ps.find(p => params(p).hp === 'no' && params(p).nsaid === 'yes')!;
    const ev = (p: Patient, treatments: Id[]) => evaluatePlan(db, p, { treatments, setting: 'home' }, []);
    expect(ev(hp, ['tx.ppi']).requireMissing).toEqual([ERAD]);
    expect(ev(hp, ['tx.ppi', ERAD]).requireMissing).toEqual([]);
    expect(ev(nsaid, ['tx.ppi']).requireMissing).toEqual([STOP]);
    expect(ev(nsaid, ['tx.ppi', STOP]).requireMissing).toEqual([]);
    expect(ev(hp, ['tx.ppi', ERAD]).effective).toBe(true);
  });

  test('язва заживает на ИПН 4–6 недель, при H. pylori — и от эрадикации', () => {
    const cure = (tx: Id) => db.treatments[tx].effects.filter(e => e.on === PUD && e.kind === 'cure').map(e => [e.days, e.when ?? null]);
    expect(cure('tx.ppi')).toEqual([[[28, 42], null]]);
    expect(cure(ERAD)).toEqual([[[28, 42], { hp: ['yes'] }]]);
  });
});

describe('гастрит, ассоциированный с H. pylori', () => {
  const ps = people(HPG, 400, 53_800);

  test('H. pylori — у каждого: так гастрит и определён; на ЭГДС покраснение и отёк — часто; язвы нет', () => {
    for (const p of ps) {
      expect(has(p, HP)).toBe(true);
      expect(has(p, 'img.egd_ulcer')).toBe(false);
    }
    near(share(ps, p => has(p, 'img.egd_gastritis')), 0.5, 0.08);
  });

  test('тактика: эрадикация — первая линия, ИПН облегчает; дома. У функциональной диспепсии и рефлюкса эрадикация не нужна', () => {
    expect(txRole(db, HPG, ERAD)).toBe('firstLine');
    expect(txRole(db, HPG, 'tx.ppi')).toBe('supportive');
    expect(db.conditions[HPG].treatment!.setting.default).toBe('home');
    for (const id of [FD, GERD]) expect(txRole(db, id, ERAD)).toBe('notIndicated');
    // эрадикация излечивает гастрит у 9 из 10: с висмутом — «выше 90%» (277_2, 708_2)
    expect(db.treatments[ERAD].effects.find(e => e.on === HPG)).toMatchObject({ kind: 'cure', p: 9000 });
    // у беременных эрадикацию не проводят (277_2, раздел 7.1.1)
    expect(db.treatments[ERAD].contraindications).toEqual([{ id: 'risk.pregnancy', level: 'absolute', reaction: 0 }]);
  });

  test('у функциональной диспепсии и рефлюкса H. pylori нет: тест положителен только по ошибке', () => {
    for (const p of [...people(FD, 200, 54_200), ...people(GERD, 200, 54_400)]) expect(has(p, HP)).toBe(false);
  });
});

describe('язвенное кровотечение: H. pylori', () => {
  test('у трёх из четырёх — H. pylori; эрадикация после остановки — желательна, без него — не нужна', () => {
    const ps = Array.from({ length: 400 }, (_, i) => generatePatient(db, 55_000 + i, { department: 'dept.surgery', departments: ['dept.therapy', 'dept.surgery'], season: 'autumn', primary: UB, params: {} }));
    near(share(ps, p => params(p).hp === 'yes'), 0.76, 0.06);
    for (const p of ps) expect(has(p, HP)).toBe(params(p).hp === 'yes');
    expect(txRole(db, UB, ERAD, { forrest: 'low', shock: 'no', hp: 'yes' })).toBe('supportive');
    expect(txRole(db, UB, ERAD, { forrest: 'low', shock: 'no', hp: 'no' })).toBe('notIndicated');
  });
});

describe('среди пришедших с болью под ложечкой', () => {
  test('H. pylori — у трети с небольшим (по 708_2 — у 38,8 % взрослых); язва — около десятой части', () => {
    const DYS = [FD, GERD, HPG, PUD];
    const seasons = ['winter', 'spring', 'summer', 'autumn'] as const;
    const ps = Array.from({ length: 16000 }, (_, i) => generatePatient(db, 900_000 + i, { department: 'dept.therapy', season: seasons[i % 4], walkIn: true }))
      .filter(p => DYS.includes(p.truth.conditions.find(c => c.role === 'primary')!.id));
    expect(ps.length).toBeGreaterThan(600);
    const of = (id: Id) => share(ps, p => p.truth.conditions.find(c => c.role === 'primary')!.id === id);
    near(share(ps, p => has(p, HP)), 0.36, 0.07);
    near(of(PUD), 0.11, 0.04);
    near(of(HPG), 0.27, 0.06);
    // доля НПВП для вывода в записи язвы — та, что у пришедших сами: у принимающих НПВП язва в 4–5 раз чаще
    const pud = ps.filter(p => p.truth.conditions.find(c => c.role === 'primary')!.id === PUD);
    near(share(pud, p => p.truth.conditions.find(c => c.role === 'primary')!.params.nsaid === 'yes'), db.conditions[PUD].params!.nsaid.yes / 100, 0.1);
  });
});

/** Разумный врач по шагам: что делает и что решает. */
function doctor(p: Patient, exams: readonly Id[], venue: Venue) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, TH);
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams: [...exams], threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  const all = Object.keys(db.exams).sort();
  const noEgd = all.filter(e => e !== 'exam.egd');
  const run = (cond: Id, from: number, exams: readonly Id[], venue: Venue) => people(cond, 100, from).map(p => ({ p, r: doctor(p, exams, venue) }));
  const eradicated = (rs: ReturnType<typeof run>) => share(rs.filter(x => has(x.p, HP)), x => x.r.plan.treatments.includes(ERAD));

  test('с эндоскопией: язва — по ЭГДС, при H. pylori эрадикация; гастрит — эрадикация', () => {
    const hospital: Venue = { ward: true, icu: true, rooms: ['room.endoscopy'] };
    const pud = run(PUD, 5300, all, hospital);
    expect(share(pud, x => x.r.diagnosis === PUD)).toBeGreaterThan(0.85);
    expect(share(pud, x => x.r.done.includes('exam.egd'))).toBeGreaterThan(0.5);
    expect(eradicated(pud)).toBeGreaterThan(0.85);
    const hpg = run(HPG, 5300, all, hospital);
    expect(share(hpg, x => x.r.diagnosis === HPG)).toBeGreaterThan(0.8);
    expect(eradicated(hpg)).toBeGreaterThan(0.8);
    for (const x of [...pud, ...hpg]) expect(x.r.plan.setting).toBe('home');
  });

  test('без эндоскопии — «найди и лечи»: тест на H. pylori, при нём эрадикация; язву и гастрит путают — их различает ЭГДС', () => {
    const pud = run(PUD, 5300, noEgd, {});
    const hpg = run(HPG, 5300, noEgd, {});
    expect(share([...pud, ...hpg], x => x.r.done.includes('exam.hp_stool'))).toBeGreaterThan(0.6);
    expect(eradicated(pud)).toBeGreaterThan(0.8);
    expect(eradicated(hpg)).toBeGreaterThan(0.65);
    // язва без ЭГДС — то язва, то гастрит: верно реже, чем с ней
    expect(share(pud, x => x.r.diagnosis === PUD)).toBeLessThan(share(run(PUD, 5300, all, { rooms: ['room.endoscopy'] }), x => x.r.diagnosis === PUD));
    expect(share(pud, x => x.r.diagnosis === HPG)).toBeGreaterThan(0.05);
  });
});

describe('энциклопедия', () => {
  test('язва: эрадикация при H. pylori и отмена НПВП — словами; гастрит: эрадикация — первая линия', () => {
    const rows = (id: Id) => Object.fromEntries(article(db, id)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows(PUD)).toMatchObject({
      'Первая линия': ['tx.ppi'],
      'Обязательно, при Helicobacter pylori': [ERAD],
      'Не нужно, без Helicobacter pylori': [ERAD],
      'Обязательно, если принимает НПВП': [STOP],
      'Опасно': ['tx.ibuprofen', 'tx.aspirin_course'],
    });
    expect(rows(HPG)).toMatchObject({ 'Первая линия': [ERAD], 'Облегчить состояние': ['tx.ppi'] });
    expect(rows(UB)).toMatchObject({ 'Облегчить состояние, при Helicobacter pylori': [ERAD] });
    for (const id of [ERAD, STOP, HP, 'exam.hp_stool', 'img.egd_gastritis', 'sym.hunger_pain', 'hx.seasonal_pain']) expect(article(db, id)).toBeDefined();
  });
});
