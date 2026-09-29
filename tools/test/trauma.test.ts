// Травма запястья и голеностопа (spec 2026-09-chapter-2, часть 32а): перелом лучевой кости со
// скрытым смещением и перелом лодыжек со скрытой стабильностью — тактика и место по ним; ушиб
// запястья и растяжение связок голеностопа проходят сами; оттавские правила — новый вид записи
// «правило»; «виртуальный врач» уточняет то, от чего зависит лечение, и не оперирует без снимка;
// снимок кости в карте пациента; энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { likelyParams, paramBeliefs } from '../../src/engine/med/infer';
import { curesOf, primaryOf, recommendedSetting, selfLimits, tacticsFor, txRole } from '../../src/engine/med/plan';
import { choosePlan, runDoctor, tacticParams } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView, noteText } from '../../src/state/caseView';
import { article, sectionView } from '../../src/state/encyclopedia';

const RADIUS = 'cond.distal_radius_fracture';
const ANKLE = 'cond.ankle_fracture';
const SPRAIN = 'cond.ankle_sprain';
const WRIST = 'cond.wrist_contusion';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const people = (primary: Id, n: number, from = 1, params?: Record<string, string>) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'winter', primary, ...(params ? { params } : {}) }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const xr = (exam: Id, f: Id, shown: boolean): Observation => ({ f, shown, exam });
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();

describe('кто болеет и что находят', () => {
  test('травма — отделение приёмного, система «кости и суставы»; в амбулатории её нет', () => {
    for (const id of [RADIUS, ANKLE, SPRAIN, WRIST]) {
      expect(db.conditions[id]).toMatchObject({ department: 'dept.trauma', system: 'bones', kind: 'injury' });
      expect(candidates).toContain(id);
      expect(candidatesOf(db, 'dept.therapy')).not.toContain(id);
    }
    expect(db.rooms['room.emergency'].admits).toEqual(['dept.surgery', 'dept.trauma']);
    expect(db.conditions[RADIUS].confirm).toEqual(['exam.xray_wrist']);
    expect(db.conditions[ANKLE].confirm).toEqual(['exam.xray_ankle']);
    expect(db.conditions[SPRAIN].confirm).toBe('clinical');
  });

  test('перелом лучевой: оперируют 26 % (Rundgren 2020), женщин 78 %; шиловидный отросток локтевой — у 31 % (846_1)', () => {
    const ps = people(RADIUS, 3000);
    const d = (p: Patient) => primaryOf(p).params.displacement;
    near(share(ps, p => d(p) === 'unstable'), 0.26, 0.025);
    near(share(ps, p => d(p) === 'none'), 0.4, 0.03);
    near(share(ps, p => has(p, 'img.xr_ulnar_styloid')), 0.31, 0.03);
    // пол у заданной болезни не выбирается — отношение весов генератора
    const who = { age: 40, season: 'winter' as const, risks: [], chronic: [] };
    const w = (sex: 'm' | 'f') => presentingWeight(db.conditions[RADIUS], { ...who, sex });
    near(w('f') / (w('f') + w('m')), 0.78, 0.01);
  });

  test('перелом лодыжек: стабильных 57 %, нестабильных 43 % (Juto 2018); деформация и отёк у внутренней лодыжки — только у нестабильных', () => {
    const ps = people(ANKLE, 2000);
    const stable = ps.filter(p => primaryOf(p).params.stability === 'stable');
    near(stable.length / ps.length, 0.57, 0.03);
    expect(stable.some(p => has(p, 'sign.ankle_deformity') || has(p, 'sign.medial_ankle_swelling') || has(p, 'img.xr_ankle_unstable'))).toBe(false);
    const unstable = ps.filter(p => primaryOf(p).params.stability === 'unstable');
    expect(unstable.every(p => has(p, 'img.xr_ankle_unstable') && has(p, 'img.xr_ankle_fracture'))).toBe(true);
    // оттавские правила: болезненность кости у лодыжки — почти у всех с переломом (Stiell 1993: чувствительность 1,0)
    expect(share(ps, p => has(p, 'sign.malleolus_tenderness'))).toBeGreaterThan(0.93);
  });

  test('растяжение и ушиб: без снимков перелома; признаки оттавских правил бывают и без перелома — снимков меньше на 30–40 %', () => {
    const sprains = people(SPRAIN, 2000);
    expect(sprains.some(p => has(p, 'img.xr_ankle_fracture'))).toBe(false);
    const ottawa = (p: Patient) => has(p, 'sign.malleolus_tenderness') || has(p, 'sign.no_weight_bearing');
    // по всем травмам голеностопа — и переломам, и растяжениям — без признаков правил примерно треть
    near(share(sprains, p => !ottawa(p)), 0.375, 0.05);
    for (const id of [SPRAIN, WRIST]) expect(selfLimits(db, primaryOf(people(id, 1)[0]))).toBe(true);
  });

  test('сторона — в жалобе и на снимке одна и та же', () => {
    for (const p of people(RADIUS, 50)) {
      const side = primaryOf(p).params.side;
      expect(p.truth.findings.find(f => f.f === 'sym.wrist_pain')!.attrs?.side).toBe(side);
      expect(p.truth.findings.find(f => f.f === 'img.xr_radius_fracture')!.attrs?.side).toBe(side);
    }
  });
});

describe('тактика по скрытому параметру', () => {
  test('перелом лучевой: без смещения — лонгета, со смещением — репозиция, нестабильный — операция', () => {
    const role = (tx: Id, displacement: string) => txRole(db, RADIUS, tx, { displacement, side: 'right' });
    expect(role('tx.cast_splint', 'none')).toBe('firstLine');
    expect(role('tx.closed_reduction', 'none')).toBe('acceptable');
    expect(role('tx.radius_plate', 'none')).toBe('acceptable');
    expect(role('tx.closed_reduction', 'displaced')).toBe('firstLine');
    expect(role('tx.cast_splint', 'displaced')).toBe('supportive');
    expect(role('tx.radius_plate', 'displaced')).toBe('acceptable');
    expect(role('tx.radius_plate', 'unstable')).toBe('firstLine');
    expect(role('tx.cast_splint', 'unstable')).toBe('supportive');
    expect(role('tx.ibuprofen', 'unstable')).toBe('supportive');
    // без параметров — общая тактика; своя операция — первая линия
    expect(txRole(db, RADIUS, 'tx.radius_plate')).toBe('firstLine');
    expect(txRole(db, RADIUS, 'tx.closed_reduction')).toBe('acceptable');
    const t = db.conditions[RADIUS].treatment!;
    expect(tacticsFor(t, { displacement: 'displaced' }).plan).toEqual(['tx.closed_reduction', 'tx.ibuprofen']);
    expect(tacticsFor(t, { displacement: 'none' }).plan).toEqual(['tx.cast_splint', 'tx.ibuprofen']);
    expect(tacticsFor(t, { displacement: 'unstable' }).firstLine).toEqual([]);
    expect(tacticParams(db, RADIUS)).toEqual(['displacement']);
  });

  test('что лечит причину: лонгета — без смещения, репозиция — без смещения и со смещением, пластина — всё', () => {
    const cures = (tx: Id, displacement: string) => curesOf(db, { id: RADIUS, params: { displacement, side: 'left' } }, [tx]).length > 0;
    expect(['none', 'displaced', 'unstable'].map(d => cures('tx.cast_splint', d))).toEqual([true, false, false]);
    expect(['none', 'displaced', 'unstable'].map(d => cures('tx.closed_reduction', d))).toEqual([true, true, false]);
    expect(['none', 'displaced', 'unstable'].map(d => cures('tx.radius_plate', d))).toEqual([true, true, true]);
    const ankle = (tx: Id, stability: string) => curesOf(db, { id: ANKLE, params: { stability, side: 'left' } }, [tx]).length > 0;
    expect([ankle('tx.cast_splint', 'stable'), ankle('tx.cast_splint', 'unstable'), ankle('tx.ankle_orif', 'unstable')]).toEqual([true, false, true]);
  });

  test('где лечить: консервативно — дома (травмпункт), нестабильный перелом — операция', () => {
    const where = (id: Id, params: Record<string, string>) => recommendedSetting(db, people(id, 1, 1, params)[0]);
    expect(where(RADIUS, { displacement: 'none' })).toBe('home');
    expect(where(RADIUS, { displacement: 'displaced' })).toBe('home');
    expect(where(RADIUS, { displacement: 'unstable' })).toBe('surgery');
    expect(where(ANKLE, { stability: 'stable' })).toBe('home');
    expect(where(ANKLE, { stability: 'unstable' })).toBe('surgery');
    expect(where(SPRAIN, {})).toBe('home');
    // срока операции при закрытом переломе в рекомендациях нет — и в записи его нет
    expect(db.conditions[RADIUS].surgery).toEqual({ tx: 'tx.radius_plate', stay: [1, 3] });
    expect(db.conditions[ANKLE].surgery).toEqual({ tx: 'tx.ankle_orif', stay: [2, 5] });
  });
});

describe('скрытый параметр по тому, что видно', () => {
  const W = 'exam.xray_wrist';
  test('без снимка — самое частое значение; снимок со смещением — смещение; с признаками нестабильности — нестабильный', () => {
    expect(likelyParams(db, RADIUS, [], 40)).toMatchObject({ displacement: 'none' });
    const displaced = [xr(W, 'img.xr_radius_fracture', true), xr(W, 'img.xr_radius_displaced', true), xr(W, 'img.xr_radius_unstable', false)];
    expect(likelyParams(db, RADIUS, displaced, 40).displacement).toBe('displaced');
    const unstable = [xr(W, 'img.xr_radius_fracture', true), xr(W, 'img.xr_radius_displaced', true), xr(W, 'img.xr_radius_unstable', true)];
    expect(likelyParams(db, RADIUS, unstable, 40).displacement).toBe('unstable');
    const sum = paramBeliefs(db, RADIUS, 'displacement', displaced, 40).reduce((a, b) => a + b.p, 0);
    expect(sum).toBeCloseTo(1, 9);
    // деформация говорит о смещении, но не о том, стабилен ли перелом
    const deformity = paramBeliefs(db, RADIUS, 'displacement', [{ f: 'sign.wrist_deformity', shown: true, exam: 'exam.wrist_exam' }], 40);
    expect(deformity.find(b => b.value === 'none')!.p).toBeLessThan(0.05);
    expect(Math.max(...deformity.map(b => b.p))).toBeLessThan(0.9);
  });

  test('план по снимку: смещение — репозиция дома; нестабильный — операция в своей операционной или скорая', () => {
    const displaced = [xr(W, 'img.xr_radius_fracture', true), xr(W, 'img.xr_radius_displaced', true), xr(W, 'img.xr_radius_unstable', false)];
    expect(choosePlan(db, RADIUS, displaced, 40)).toEqual({ treatments: ['tx.closed_reduction', 'tx.ibuprofen'], setting: 'home' });
    const unstable = [xr(W, 'img.xr_radius_fracture', true), xr(W, 'img.xr_radius_displaced', true), xr(W, 'img.xr_radius_unstable', true)];
    expect(choosePlan(db, RADIUS, unstable, 40, { ward: true, or: true })).toEqual({ treatments: ['tx.cast_splint', 'tx.ibuprofen'], setting: 'surgery' });
    expect(choosePlan(db, RADIUS, unstable, 40).setting).toBe('ambulance');
  });
});

describe('«виртуальный врач» при травме', () => {
  const doctor = (p: Patient) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams, threshold: 0.9 });

  test('при переломе лучевой делает снимок: от смещения зависит лечение', () => {
    for (const d of ['displaced', 'unstable']) {
      const ps = people(RADIUS, 40, 100, { displacement: d });
      expect(share(ps, p => doctor(p).exams.includes('exam.xray_wrist'))).toBeGreaterThan(0.95);
    }
  });

  test('нестабильный перелом лодыжек не оперирует без снимка; растяжение без признаков оттавских правил — без снимка', () => {
    const unstable = people(ANKLE, 40, 200, { stability: 'unstable' });
    for (const p of unstable) {
      const r = doctor(p);
      if (r.plan.setting !== 'home') expect(r.exams).toContain('exam.xray_ankle');
    }
    // осмотр делают всем; снимка нет у тех, у кого осмотр не нашёл ни одного признака правил
    const runs = people(SPRAIN, 300, 300).map(doctor);
    expect(share(runs, r => r.exams.includes('exam.ankle_exam'))).toBe(1);
    const seen = (r: ReturnType<typeof doctor>, f: Id) => r.observations.some(o => o.f === f && o.shown);
    const quiet = runs.filter(r => !seen(r, 'sign.malleolus_tenderness') && !seen(r, 'sign.no_weight_bearing'));
    expect(quiet.length).toBeGreaterThan(50);
    expect(share(quiet, r => !r.exams.includes('exam.xray_ankle'))).toBeGreaterThan(0.95);
  });
});

describe('оттавские правила', () => {
  const rule = db.rules['rule.ottawa_ankle'];
  test('запись: жалоба на голеностоп, два признака, снимок голеностопа, с 18 лет; источники', () => {
    expect(rule).toMatchObject({ complaints: ['sym.ankle_pain'], any: ['sign.malleolus_tenderness', 'sign.no_weight_bearing'], exams: ['exam.xray_ankle'], ageMin: 18 });
    expect(rule.sources.map(s => s.url)).toEqual(expect.arrayContaining(['https://cr.minzdrav.gov.ru/view-cr/832_2', 'https://pubmed.ncbi.nlm.nih.gov/8433468/', 'https://pubmed.ncbi.nlm.nih.gov/12595378/']));
  });

  test('«Студенту» в карте: что проверить, «снимок нужен» с признаком, без признаков — снимок можно не делать; «Врачу» — нет', () => {
    const p = people(SPRAIN, 1, 7)[0];
    const view = (obs: Observation[], difficulty?: 'student' | 'doctor') => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: obs.length ? [{ exam: 'exam.ankle_exam', step: 1, at: 600, obs }] : [], pending: [], meanwhile: [], done: obs.length ? ['exam.ankle_exam'] : [],
      draft: { treatments: [], setting: 'home' }, departments: ED, ...(difficulty ? { difficulty } : {}),
    }).rules;
    const exam = (f: Id, shown: boolean): Observation => ({ f, shown, exam: 'exam.ankle_exam' });
    expect(view([])).toEqual([{ id: rule.id, name: rule.name.ru, text: expect.stringContaining('Проверьте: болезненность кости у лодыжки, не может пройти четыре шага') }]);
    expect(view([exam('sign.malleolus_tenderness', true), exam('sign.no_weight_bearing', false)])[0].text).toBe('Снимок нужен: болезненность кости у лодыжки');
    expect(view([exam('sign.malleolus_tenderness', false), exam('sign.no_weight_bearing', false)])[0].text).toBe(rule.texts.no.ru);
    expect(view([exam('sign.malleolus_tenderness', true)], 'doctor')).toEqual([]);
    // с жалобой на запястье правила нет
    const wrist = people(WRIST, 1, 9)[0];
    expect(makeCaseView({
      version: 0, patient: wrist, clock: 600, minutesSpent: 0, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [],
      draft: { treatments: [], setting: 'home' }, departments: ED,
    }).rules).toEqual([]);
  });
});

describe('снимок кости в карте', () => {
  const view = (patient: Patient, exam: Id, obs: Observation[]) => makeCaseView({
    version: 0, patient, clock: 600, minutesSpent: 0, money: 0, step: 1,
    arrived: [{ exam, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [exam],
    draft: { treatments: [], setting: 'home' }, departments: ED,
  }).groups.find(g => g.exam === exam)!.image;

  test('что нашёл рентгенолог: линия, смещение, нестабильность; сторона — из жалобы', () => {
    const p = people(RADIUS, 1, 11, { displacement: 'displaced', side: 'left' })[0];
    const W = 'exam.xray_wrist';
    expect(view(p, W, [xr(W, 'img.xr_radius_fracture', true), xr(W, 'img.xr_radius_displaced', false)])).toMatchObject({ kind: 'bone', view: 'wrist', side: 'left', fractures: [{ site: 'radius', displacement: 0 }] });
    expect(view(p, W, [xr(W, 'img.xr_radius_fracture', true), xr(W, 'img.xr_radius_displaced', true)])).toMatchObject({ fractures: [{ site: 'radius', displacement: 0.55 }] });
    expect(view(p, W, [xr(W, 'img.xr_radius_fracture', false)])).toMatchObject({ kind: 'bone', fractures: [] });
    const a = people(ANKLE, 1, 12, { stability: 'unstable', side: 'right' })[0];
    const A = 'exam.xray_ankle';
    expect(view(a, A, [xr(A, 'img.xr_ankle_fracture', true), xr(A, 'img.xr_ankle_unstable', true)])).toMatchObject({
      kind: 'bone', view: 'ankle', side: 'right',
      fractures: [{ site: 'fibula', displacement: 0.8 }, { site: 'medial_malleolus', displacement: 0.8 }],
    });
  });
});

describe('разбор и энциклопедия', () => {
  test('не лекарство — «лечение выбора» и своя строка «допустимо»', () => {
    expect(noteText({ code: 'tx.acceptable', tx: 'tx.radius_plate' })).toBe('Остеосинтез лучевой кости пластиной: допустимо, но здесь лучше лечение выбора');
    expect(noteText({ code: 'tx.acceptable', tx: 'tx.ibuprofen' })).toContain('препарат выбора');
  });

  test('статья болезни: тактика по смещению, где лечить, правила; статья правила — в «Шкалах и правилах»', () => {
    const radius = article(db, RADIUS)!;
    const tx = JSON.stringify(radius.blocks.find(b => b.key === 'treatment'));
    expect(tx).toContain('Первая линия, при смещении');
    expect(tx).toContain('Закрытая репозиция и гипсовая лонгета');
    const where = radius.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toContain('При нестабильном переломе — операция.');
    expect(where).toContain('Операция — остеосинтез лучевой кости пластиной.');
    expect(JSON.stringify(article(db, ANKLE)!.blocks.find(b => b.key === 'rules'))).toContain('rule.ottawa_ankle');
    const r = article(db, 'rule.ottawa_ankle')!;
    expect(r).toMatchObject({ section: 'scores', title: 'Оттавские правила для голеностопа' });
    expect(r.blocks.map(b => b.key)).toEqual(['what', 'when', 'any', 'none', 'exams', 'about', 'sources']);
    expect(sectionView(db, 'scores').groups.map(g => g.key)).toEqual(['scores', 'rules']);
    // лечение: первая линия при переломе со смещением — с условием
    const reduction = JSON.stringify(article(db, 'tx.closed_reduction')!.blocks.find(b => b.key === 'usedAs'));
    expect(reduction).toContain('при смещении');
    expect(JSON.stringify(article(db, 'sign.malleolus_tenderness')!.blocks.find(b => b.key === 'inRules'))).toContain('rule.ottawa_ankle');
  });
});
