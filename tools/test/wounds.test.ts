// Раны (spec 2026-09-chapter-2, часть 32г-2): открытая рана кисти и рана волосистой части головы;
// тактика по скрытым параметрам — шов, повязка или обработка без шва, перевод при перерезанном
// сухожилии, палата при большой ране; обязательная профилактика — столбняк по записям о прививках,
// бешенство и антибиотик после укуса; обязательные при жалобе осмотры; «виртуальный врач»;
// энциклопедия и карта пациента.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { examFits } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan, preventOf, recommendedSetting, tacticsFor, txRole } from '../../src/engine/med/plan';
import { choosePlan, nextStep, runDoctor, tacticParams } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { noteText, treatmentGroupsFor } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const HAND = 'cond.hand_wound';
const HEAD = 'cond.head_wound';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const SUTURE = 'tx.wound_suture';
const OPEN = 'tx.wound_open';
const DRESSING = 'tx.wound_dressing';
const TOXOID = 'tx.tetanus_toxoid';
const TIG = 'tx.tetanus_ig';
const RABIES = 'tx.rabies_vaccine';
const RIG = 'tx.rabies_ig';
const AMOXCLAV = 'tx.amoxicillin_clavulanate';

const people = (primary: Id, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'autumn', primary }));
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const params = (p: Patient) => p.truth.conditions[0].params;
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();
const doctor = (p: Patient) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 });
/** пациент с заданными значениями скрытых параметров — ищем среди сгенерированных */
const find = (primary: Id, want: Record<string, string>, from = 1) => {
  for (let i = 0; i < 4000; i++) {
    const p = people(primary, 1, from + i)[0];
    if (Object.entries(want).every(([k, v]) => params(p)[k] === v)) return p;
  }
  throw new Error(`нет пациента ${primary} ${JSON.stringify(want)}`);
};
const scoreOf = (p: Patient, treatments: Id[], setting: 'home' | 'transfer' | 'admit' = 'home', obs: Observation[] = []) => {
  const ev = evaluatePlan(db, p, { treatments, setting }, obs);
  return { ev, score: scoreCase({ verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev, outcome: { kind: 'recovered', day: 7 } as never, selfLimiting: false, redFlags: [] }) };
};

describe('записи ран', () => {
  test('обе — травма, «Кожа и раны», лёгкие; кисть S61.9 — частая, голова S01.0; источники — 688_2, 733_2, 979_1, 856_1', () => {
    for (const id of [HAND, HEAD]) expect(db.conditions[id]).toMatchObject({ department: 'dept.trauma', system: 'skin', kind: 'injury', severity: 'minor', presenting: true });
    expect(db.conditions[HAND].icd10).toBe('S61.9');
    expect(db.conditions[HEAD].icd10).toBe('S01.0');
    expect(db.conditions[HAND].weight).toBeGreaterThan(db.conditions[HEAD].weight);
    const urls = (id: Id) => db.conditions[id].sources.map(s => s.url);
    expect(urls(HAND)).toEqual(expect.arrayContaining(['https://cr.minzdrav.gov.ru/view-cr/688_2', 'https://cr.minzdrav.gov.ru/view-cr/979_1', 'https://cr.minzdrav.gov.ru/view-cr/856_1']));
    expect(urls(HEAD)).toEqual(expect.arrayContaining(['https://cr.minzdrav.gov.ru/view-cr/733_2', 'https://cr.minzdrav.gov.ru/view-cr/979_1', 'https://cr.minzdrav.gov.ru/view-cr/856_1']));
  });

  test('жалобы: у каждого — рана на кисти или голове; у укушенного — ещё «Укус животного»', () => {
    for (const p of people(HAND, 300)) {
      expect(p.complaints).toContain('sym.hand_wound');
      expect(p.complaints.includes('sym.animal_bite')).toBe(params(p).cause === 'bite');
    }
    for (const p of people(HEAD, 300)) {
      expect(p.complaints).toContain('sym.head_wound');
      expect(p.complaints.includes('sym.animal_bite')).toBe(params(p).cause === 'bite');
    }
  });

  test('скрытые параметры — по долям записи; признаки — по параметрам: давность, края, сухожилие, прививки, размер', () => {
    const hand = people(HAND, 2000);
    near(share(hand, p => params(p).cause === 'bite'), 0.2, 0.03);
    near(share(hand, p => params(p).tendon === 'cut'), 0.1, 0.025);
    near(share(hand, p => params(p).tetanus === 'none'), 0.3, 0.03);
    for (const p of hand) {
      expect(has(p, 'hx.wound_late')).toBe(params(p).delay === 'late');
      expect(has(p, 'sign.wound_gaping')).toBe(params(p).edges === 'apart');
      expect(has(p, 'sign.finger_flexion_loss')).toBe(params(p).tendon === 'cut');
      expect(has(p, 'hx.tetanus_records')).toBe(params(p).tetanus !== 'none');
      expect(has(p, 'hx.tetanus_recent')).toBe(params(p).tetanus === 'current');
    }
    const head = people(HEAD, 2000);
    near(share(head, p => params(p).extent === 'large'), 0.1, 0.025);
    for (const p of head) expect(has(p, 'sign.wound_large')).toBe(params(p).extent === 'large');
    // рана головы — без признаков черепно-мозговой травмы (733_2, раздел 2)
    for (const p of head) for (const f of ['sym.loss_of_consciousness', 'sym.amnesia', 'sym.seizure_after_injury', 'sign.gcs_low']) expect(has(p, f)).toBe(false);
  });
});

describe('тактика по скрытым параметрам', () => {
  const role = (id: Id, tx: Id, p: Record<string, string>) => txRole(db, id, tx, p);
  const cut = { cause: 'cut', delay: 'fresh', edges: 'apart', tendon: 'intact', tetanus: 'current' };

  test('кисть: свежий порез, края расходятся — шов; сходятся — повязка, шов можно; старше суток — обработка без шва', () => {
    expect(role(HAND, SUTURE, cut)).toBe('firstLine');
    expect(role(HAND, DRESSING, cut)).toBe('supportive');
    expect(role(HAND, OPEN, cut)).toBe('acceptable');
    expect(role(HAND, DRESSING, { ...cut, edges: 'together' })).toBe('firstLine');
    expect(role(HAND, SUTURE, { ...cut, edges: 'together' })).toBe('acceptable');
    expect(role(HAND, OPEN, { ...cut, delay: 'late' })).toBe('firstLine');
    expect(role(HAND, SUTURE, { ...cut, delay: 'late' })).toBe('notIndicated');
  });

  test('укус: обработка без шва, шов вреден (979_1: швы при риске бешенства не накладывают); вакцина, иммуноглобулин и антибиотик — профилактика', () => {
    const bite = { ...cut, cause: 'bite' };
    expect(role(HAND, OPEN, bite)).toBe('firstLine');
    expect(role(HAND, SUTURE, bite)).toBe('harmful');
    for (const tx of [RABIES, RIG, AMOXCLAV]) expect(role(HAND, tx, bite)).toBe('prevent');
    for (const tx of [RABIES, RIG]) expect(role(HAND, tx, cut)).toBe('notIndicated');
    const headBite = { cause: 'bite', extent: 'small', tetanus: 'current' };
    expect(role(HEAD, OPEN, headBite)).toBe('firstLine');
    expect(role(HEAD, SUTURE, headBite)).toBe('harmful');
    expect(role(HEAD, SUTURE, { ...headBite, cause: 'blunt' })).toBe('firstLine');
    for (const tx of [RABIES, RIG, AMOXCLAV]) expect(role(HEAD, tx, headBite)).toBe('prevent');
  });

  test('столбняк: меньше 5 лет — ничего; больше 5 лет — анатоксин; записей нет — анатоксин и иммуноглобулин (856_1, приложение А3.1)', () => {
    expect(preventOf(db.conditions[HAND].treatment, cut)).toEqual([]);
    expect(preventOf(db.conditions[HAND].treatment, { ...cut, tetanus: 'overdue' })).toEqual([TOXOID]);
    expect(preventOf(db.conditions[HAND].treatment, { ...cut, tetanus: 'none' })).toEqual([TOXOID, TIG]);
    expect(role(HAND, TIG, { ...cut, tetanus: 'overdue' })).toBe('notIndicated');
    expect(role(HAND, TOXOID, cut)).toBe('notIndicated');
    // без значений — вся профилактика, какая бывает
    expect(preventOf(db.conditions[HEAD].treatment).sort()).toEqual([AMOXCLAV, RABIES, RIG, TIG, TOXOID].sort());
    expect(tacticsFor(db.conditions[HAND].treatment!, { ...cut, cause: 'bite', tetanus: 'none' }).prevent).toEqual([RABIES, RIG, AMOXCLAV, TOXOID, TIG]);
  });

  test('перерезанное сухожилие — повязка и перевод, кожу не шьют; большая рана головы — палата', () => {
    const tendon = { ...cut, tendon: 'cut' };
    expect(role(HAND, DRESSING, tendon)).toBe('firstLine');
    expect(role(HAND, SUTURE, tendon)).toBe('notIndicated');
    expect(recommendedSetting(db, find(HAND, { tendon: 'cut' }))).toBe('transfer');
    expect(recommendedSetting(db, find(HAND, { tendon: 'intact' }))).toBe('home');
    expect(recommendedSetting(db, find(HEAD, { extent: 'large' }))).toBe('ward');
    expect(recommendedSetting(db, find(HEAD, { extent: 'small' }))).toBe('home');
    expect(tacticParams(db, HAND)).toEqual(['cause', 'delay', 'edges', 'tendon', 'tetanus']);
    expect(tacticParams(db, HEAD)).toEqual(['cause', 'extent', 'tetanus']);
  });
});

describe('обязательная профилактика в оценке', () => {
  test('нет анатоксина при просроченной прививке — замечание, лечение и безопасность не выше C; с ним — пятёрка', () => {
    const p = find(HAND, { cause: 'cut', delay: 'fresh', edges: 'apart', tendon: 'intact', tetanus: 'overdue' });
    const without = scoreOf(p, [SUTURE, 'tx.paracetamol']);
    expect(without.ev.preventMissing).toEqual([TOXOID]);
    expect(without.score.notes).toContainEqual({ code: 'tx.preventMissing', tx: TOXOID });
    expect(without.score.treatment).toBe('C');
    expect(without.score.safety).toBe('C');
    expect(noteText({ code: 'tx.preventMissing', tx: TOXOID })).toBe('Не назначено: анатоксин столбнячный — без этой профилактики лечение неполное');
    const full = scoreOf(p, [SUTURE, 'tx.paracetamol', TOXOID]);
    expect(full.ev.preventMissing).toEqual([]);
    expect(full.ev.roles).toContainEqual({ tx: TOXOID, role: 'prevent' });
    expect(full.score.treatment).toBe('A');
    expect(full.score.overall).toBe('A');
  });

  test('переведённого прививают там, куда перевели; аллергия на пенициллины, о которой врач знает, — антибиотик в вину не ставят', () => {
    const tendon = find(HAND, { tendon: 'cut', tetanus: 'none' });
    const moved = scoreOf(tendon, [DRESSING], 'transfer');
    expect(moved.score.notes.some(n => n.code === 'tx.preventMissing')).toBe(false);
    expect(moved.score.treatment).toBe('A');
    const bite = find(HAND, { cause: 'bite', tendon: 'intact', tetanus: 'current' });
    const allergy: Observation[] = [{ f: 'hx.allergy_penicillin', shown: true, exam: 'exam.ask_allergies' }];
    expect(scoreOf(bite, [OPEN, RABIES, RIG]).ev.preventMissing).toEqual([AMOXCLAV]);
    expect(scoreOf(bite, [OPEN, RABIES, RIG], 'home', allergy).ev.preventMissing).toEqual([]);
  });
});

describe('обследования ран', () => {
  test('осмотр раны, расспрос о прививках — при ране и укусе; движения пальцев — при ране кисти; терапевтическому больному их нет', () => {
    const hand = people(HAND, 1)[0];
    const head = people(HEAD, 1)[0];
    const flu = people('cond.influenza', 1)[0];
    const fits = (id: Id, p: Patient) => examFits(db.exams[id], p);
    expect(['exam.wound_exam', 'exam.ask_tetanus', 'exam.hand_function'].map(id => fits(id, hand))).toEqual([true, true, true]);
    expect(['exam.wound_exam', 'exam.ask_tetanus', 'exam.hand_function', 'exam.ask_head_injury'].map(id => fits(id, head))).toEqual([true, true, false, true]);
    expect(['exam.wound_exam', 'exam.ask_tetanus', 'exam.hand_function', 'exam.ask_head_injury'].map(id => fits(id, flu))).toEqual([false, false, false, false]);
    // с частью 44в — и при судорожном приступе (741_1, раздел 2.2)
    expect(db.exams['exam.neuro_exam'].routineFor).toEqual(['sym.head_injury', 'sym.head_wound', 'sym.seizure']);
  });

  test('обязательные при жалобе: рана головы — расспрос о травме головы, неврологический осмотр и осмотр раны первыми; у больного гриппом их нет', () => {
    const firstExams = (p: Patient, n: number) => {
      const done: Id[] = [];
      let phase = {};
      for (let i = 0; i < n; i++) {
        const x = nextStep(db, p, [], done, phase, { candidates, exams, threshold: 0.9, minGain: 0.02 });
        if (x.step.kind !== 'exam') break;
        done.push(x.step.exam);
        phase = x.phase;
      }
      return done;
    };
    // у этого человека ещё и понос: общий осмотр — тоже каждому (spec 2026-10-chapter-4, часть 49а)
    for (const id of [HEAD, HAND]) expect(people(id, 1)[0].complaints).toContain('sym.diarrhea');
    expect(firstExams(people(HEAD, 1)[0], 5).sort()).toEqual(['exam.ask_chronic', 'exam.ask_head_injury', 'exam.general_exam', 'exam.neuro_exam', 'exam.wound_exam']);
    expect(firstExams(people(HAND, 1)[0], 4).sort()).toEqual(['exam.ask_chronic', 'exam.general_exam', 'exam.hand_function', 'exam.wound_exam']);
    expect(firstExams(people('cond.migraine', 1)[0], 2)).not.toContain('exam.neuro_exam');
  });
});

describe('«виртуальный врач» на ранах', () => {
  const run = (id: Id, n: number) => people(id, n, 500).map(p => ({ p, r: doctor(p) }));

  test('рана кисти: верно у всех; план — по правде у 90 % и больше; профилактика назначена почти всегда', () => {
    const xs = run(HAND, 200);
    expect(share(xs, x => x.r.correct)).toBe(1);
    const good = xs.filter(x => {
      const ev = evaluatePlan(db, x.p, x.r.plan, x.r.observations);
      return ev.preventMissing.length === 0 && ev.roles.every(r => r.role !== 'harmful' && r.role !== 'notIndicated');
    });
    expect(good.length / xs.length).toBeGreaterThan(0.9);
    // перерезанное сухожилие — перевод
    for (const x of xs.filter(x => params(x.p).tendon === 'cut' && x.r.observations.some(o => o.f === 'sign.finger_flexion_loss' && o.shown))) expect(x.r.plan.setting).toBe('ambulance');
  });

  test('рана головы: верно у всех; неврологический осмотр — у каждого; укус — вакцина и иммуноглобулин', () => {
    const xs = run(HEAD, 200);
    expect(share(xs, x => x.r.correct)).toBe(1);
    for (const x of xs) expect(x.r.exams).toEqual(expect.arrayContaining(['exam.neuro_exam', 'exam.ask_head_injury', 'exam.wound_exam', 'exam.ask_tetanus']));
    const bitten = find(HEAD, { cause: 'bite' });
    const plan = choosePlan(db, HEAD, doctor(bitten).observations, bitten.age);
    expect(plan.treatments).toEqual(expect.arrayContaining([OPEN, RABIES, RIG]));
    expect(plan.treatments).not.toContain(SUTURE);
  });
});

describe('на экране и в энциклопедии', () => {
  test('решение: группы «Раны и повязки» и «Прививки и сыворотки»', () => {
    const titles = treatmentGroupsFor([]).map(g => g.title);
    expect(titles).toEqual(expect.arrayContaining(['Раны и повязки', 'Прививки и сыворотки']));
    const groups = Object.fromEntries(treatmentGroupsFor([]).map(g => [g.key, g.items.map(x => x.id)]));
    // и туалет ожоговой раны с повязкой (часть 32д-2)
    expect(groups.wounds.sort()).toEqual([OPEN, DRESSING, SUTURE, 'tx.burn_dressing'].sort());
    expect(groups.vaccines.sort()).toEqual([RIG, RABIES, TIG, TOXOID].sort());
  });

  test('статья раны кисти: обязательная профилактика по условиям, где лечить — перевод при перерезанном сухожилии', () => {
    const a = article(db, HAND)!;
    const rows = a.blocks.find(b => b.key === 'treatment')!.rows!;
    const labels = rows.map(r => r.label);
    expect(labels).toContain('Обязательная профилактика, при укусе');
    expect(labels).toContain('Обязательная профилактика, при прививке от столбняка больше 5 лет назад');
    expect(labels).toContain('Обязательная профилактика, без записей о прививках от столбняка');
    expect(a.blocks.find(b => b.key === 'where')!.text!.join(' ')).toContain('При перерезанном сухожилии — скорая, перевод в центр.');
    expect(a.subtitle).toContain('Кожа и раны');
  });

  test('статья анатоксина: «Профилактика при» — обе раны и ожог с условием', () => {
    const rows = article(db, TOXOID)!.blocks.find(b => b.key === 'usedAs')!.rows!;
    const prevent = rows.find(r => r.label === 'Профилактика при')!;
    expect(prevent.refs!.map(r => r.id).sort()).toEqual([HAND, HAND, HEAD, HEAD, 'cond.burn', 'cond.burn'].sort());
  });
});
