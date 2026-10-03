// Неотложное (spec 2026-09-chapter-2, часть 33б): острая ишемия ноги — «6 П», гепарин и перевод в
// сосудистый центр, шкала Уэллса при ней не применяется; анафилактический шок — причина реакции,
// эпинефрин в мышцу бедра до приезда скорой; носовое кровотечение — источник спереди или сзади и
// своя тактика. Низкое давление — порог на измерении высокого: одно число на двоих.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { P_ONE, Rng } from '../../src/engine/core/rng';
import { runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { news2, scaleTriage } from '../../src/engine/med/news2';
import { evaluatePlan, recommendedSetting, tacticsFor, txRole } from '../../src/engine/med/plan';
import { runDoctor } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { vitalOn } from '../../src/engine/shift/ward';
import { makeCaseView, noteText, treatmentGroupsFor } from '../../src/state/caseView';
import { article, similar } from '../../src/state/encyclopedia';

const ALI = 'cond.limb_ischemia';
const ANA = 'cond.anaphylaxis';
const NOSE = 'cond.epistaxis';
const LOW = 'vital.bp_low';
const HIGH = 'vital.bp_high';
const VITALS = 'exam.vitals';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const people = (primary: Id, n: number, from = 1, params?: Record<string, string>, departments = ED) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments, season: 'summer', primary, ...(params ? { params } : {}) }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const params = (p: Patient) => p.truth.conditions[0].params;
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const ob = (exam: Id, f: Id, shown: boolean): Observation => ({ f, shown, exam });
const exams = Object.keys(db.exams).sort();
const doctor = (p: Patient, departments = ED) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), {
  candidates: candidatesOf(db, departments), exams, threshold: 0.9, ...(departments === ED ? { venue: { ward: true, or: true } } : {}),
});
const scoreOf = (p: Patient, treatments: Id[], setting: 'home' | 'ambulance' | 'ward') => {
  const ev = evaluatePlan(db, p, { treatments, setting }, []);
  return { ev, score: scoreCase({ verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev, outcome: { kind: 'transferred', day: 0 } as never, selfLimiting: false, redFlags: [] }) };
};

describe('низкое давление — порог на измерении высокого', () => {
  const shock = people(ANA, 400, 1, undefined, ['dept.therapy']);

  test('запись: то же измерение, те же единицы; «есть» — ниже 90, без «нет» в карте', () => {
    const low = db.findings[LOW];
    expect(low.value).toMatchObject({ of: HIGH, unit: db.findings[HIGH].value!.unit, decimals: 0 });
    expect(low.value!.present[1]).toBeLessThan(90);
    expect(low.texts.absent).toBeUndefined();
    expect(low.triage).toBe('red');
    // в осмотре — только вместе с тонометром и с точностью из его измерения
    const checks = db.exams[VITALS].checks;
    expect(checks.find(c => c.f === LOW)).toMatchObject({ sens: checks.find(c => c.f === HIGH)!.spec, spec: P_ONE });
  });

  test('у пациента одно число: низкое давление — без высокого, число из диапазона «есть» низкого', () => {
    let low = 0;
    for (const p of shock) {
      expect(has(p, LOW) && has(p, HIGH)).toBe(false);
      expect(p.truth.values[LOW]).toBe(p.truth.values[HIGH]);
      if (!has(p, LOW)) continue;
      low++;
      const [lo, hi] = db.findings[LOW].value!.present;
      expect(p.truth.values[HIGH]).toBeGreaterThanOrEqual(lo);
      expect(p.truth.values[HIGH]).toBeLessThanOrEqual(hi);
    }
    // шок — «обычно» (263_2, термины: верхнее ниже 90 или на 30 % ниже рабочего)
    near(low / shock.length, 0.75, 0.07);
  });

  test('осмотр: «есть», если тонометр показал ниже 90; ошибается вместе с тонометром, ложного «есть» нет', () => {
    let tp = 0, pos = 0, fp = 0, neg = 0;
    for (const [i, p] of [...shock, ...people('cond.hypertension_new', 200, 1, undefined, ['dept.therapy'])].entries()) {
      const obs = runExam(db, p, VITALS, Rng.seeded(i).fork('v'));
      const low = obs.find(o => o.f === LOW)!;
      const high = obs.find(o => o.f === HIGH)!;
      expect(low.value).toBe(high.value);
      expect(low.shown).toBe(low.value! < 90);
      if (has(p, LOW)) { pos++; if (low.shown) tp++; } else { neg++; if (low.shown) fp++; }
    }
    expect(fp).toBe(0);
    expect(neg).toBeGreaterThan(200);
    near(tp / pos, db.exams[VITALS].checks.find(c => c.f === HIGH)!.spec / P_ONE, 0.05);
    // «Студенту» — правда: низкое давление показано у каждого, у кого оно есть
    for (const p of shock.filter(q => has(q, LOW)).slice(0, 50)) expect(runExam(db, p, VITALS, Rng.seeded(1), undefined, true).find(o => o.f === LOW)!.shown).toBe(true);
  });

  test('в карте — число тонометра и строка «давление низкое»; у остальных строки нет', () => {
    const p = shock.find(q => has(q, LOW))!;
    const card = (obs: Observation[], patient: Patient) => makeCaseView({
      version: 0, patient, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: [{ exam: VITALS, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [VITALS],
      draft: { treatments: [], setting: 'home' }, departments: ['dept.therapy'],
    }).groups.find(g => g.exam === VITALS)!;
    const exact = runExam(db, p, VITALS, Rng.seeded(1), undefined, true);
    const texts = card(exact, p).lines.map(x => x.text);
    expect(texts).toContain('Давление низкое: верхнее ниже 90');
    expect(texts.some(t => t.startsWith(`Давление ${p.truth.values[HIGH]}/`))).toBe(true);
    const calm = people('cond.arvi', 1, 5, undefined, ['dept.therapy'])[0];
    const calmTexts = card(runExam(db, calm, VITALS, Rng.seeded(1), undefined, true), calm).lines.map(x => x.text);
    expect(calmTexts.some(t => t.includes('низкое'))).toBe(false);
  });

  test('NEWS2 считает низкое верхнее давление — 3 балла; сортировка — красный', () => {
    const w = news2(db, { [HIGH]: 75 })!;
    expect(w.parts).toEqual([{ f: HIGH, value: 75, points: 3 }]);
    const p = shock.find(q => has(q, LOW))!;
    const obs = runExam(db, p, VITALS, Rng.seeded(2), undefined, true);
    expect(scaleTriage(db, p.complaints, obs).triage).toBe('red');
  });

  test('в палате хуже — давление ниже, а не выше', () => {
    const p = shock.find(q => has(q, LOW))!;
    const v = p.truth.values[HIGH];
    expect(vitalOn(db, p, { worseAfter: 1 } as never, HIGH, 3)).toBeLessThan(v);
    const q = people('cond.hypertension_new', 40, 1, undefined, ['dept.therapy']).find(x => has(x, HIGH))!;
    expect(vitalOn(db, q, { worseAfter: 1 } as never, HIGH, 3)).toBeGreaterThanOrEqual(q.truth.values[HIGH]);
  });
});

describe('острая ишемия ноги', () => {
  test('запись: хирургия, «Сердце и сосуды», критическое; с 50 лет; перевод; клинический диагноз', () => {
    expect(db.conditions[ALI]).toMatchObject({ department: 'dept.surgery', system: 'heart', severity: 'critical', icd10: 'I74.3', confirm: 'clinical' });
    expect(db.conditions[ALI].age.min).toBe(50);
    expect(db.conditions[ALI].sources.map(s => s.url)).toContain('https://cr.minzdrav.gov.ru/view-cr/1006_1');
    expect(db.conditions[ALI].treatment!.setting.default).toBe('transfer');
    expect(txRole(db, ALI, 'tx.heparin_iv')).toBe('firstLine');
    for (const tx of ['tx.compression', 'tx.doac']) expect(txRole(db, ALI, tx)).toBe('notIndicated');
  });

  test('«6 П»: боль у каждого, пульса на стопе нет у каждого, онемение — обычно, парез — иногда', () => {
    const xs = people(ALI, 600);
    for (const p of xs) {
      expect(p.complaints).toContain('sym.leg_pain');
      expect(has(p, 'sign.foot_pulse_absent')).toBe(true);
      expect(has(p, 'img.us_artery_occluded')).toBe(true);
      expect(recommendedSetting(db, p)).toBe('transfer');
    }
    near(share(xs, p => has(p, 'sym.leg_numb')), 0.75, 0.06);
    near(share(xs, p => has(p, 'sign.leg_paresis')), 0.25, 0.06);
  });

  test('мерцательная аритмия — главный фактор: у заболевших встречается в разы чаще, чем у остальных после 50', () => {
    const xs = Array.from({ length: 20000 }, (_, i) => generatePatient(db, 500_000 + i, { department: 'dept.therapy', departments: ED, season: 'winter' }));
    const old = xs.filter(p => p.age >= 50);
    const ali = old.filter(p => p.truth.conditions[0].id === ALI);
    const af = (p: Patient) => p.truth.risks.includes('risk.atrial_fibrillation');
    expect(ali.length).toBeGreaterThan(40);
    // сама по себе ишемия бывает только с 50 лет
    expect(xs.filter(p => p.truth.conditions[0].id === ALI).every(p => p.age >= 50)).toBe(true);
    expect(share(ali, af)).toBeGreaterThan(3 * share(old, af));
    // мерцательная аритмия в прошлом — почти у каждого с ней; на ЭКГ — обычно
    near(share(old.filter(af), p => has(p, 'hx.atrial_fibrillation')), 0.95, 0.04);
    near(share(old.filter(af), p => has(p, 'ecg.af')), 0.75, 0.08);
  }, 60_000);

  test('шкала Уэллса без пульса на стопе не применяется; с пульсом — применяется', () => {
    const rule = db.rules['rule.wells_dvt'];
    const known = (pulse: boolean) => knownOf([ob('exam.leg_exam', 'sign.foot_pulse_absent', pulse)]);
    expect(checkRule(rule, 70, known(true)).applies).toBe(false);
    expect(checkRule(rule, 70, known(false)).applies).toBe(true);
    expect(rule.about).toContain(ALI);
    // с чем спутать — тромбоз вен первым, и в статье тромбоза — ишемия (1006_1, раздел 2.2)
    expect(similar(db, ALI)[0]).toBe('cond.dvt');
    expect(similar(db, 'cond.dvt')).toContain(ALI);
  });

  test('«виртуальный врач»: острая ишемия — у 90 % и больше, гепарин и скорая; D-димер и УЗИ вен — редко', () => {
    // заданная болезнь возраст не выбирает: ишемия — с 50 лет, моложе врач её и не ищет
    const runs = people(ALI, 240, 2000).filter(p => p.age >= 50).slice(0, 80).map(p => ({ p, r: doctor(p) }));
    expect(runs.length).toBe(80);
    expect(share(runs, x => x.r.correct)).toBeGreaterThan(0.9);
    expect(share(runs, x => x.r.plan.setting === 'ambulance' && x.r.plan.treatments.includes('tx.heparin_iv'))).toBeGreaterThan(0.9);
    expect(share(runs, x => x.r.exams.includes('exam.us_leg_veins'))).toBeLessThan(0.3);
  });

  test('оценка: без гепарина до перевода — «до приезда скорой не назначено»; тромбоз вен вместо ишемии — дома, мимо', () => {
    const p = people(ALI, 1, 7)[0];
    const bare = scoreOf(p, [], 'ambulance');
    expect(bare.score.notes.some(n => n.code === 'tx.preHospitalMissing' && n.tx === 'tx.heparin_iv')).toBe(true);
    expect(noteText({ code: 'tx.preHospitalMissing', tx: 'tx.heparin_iv' })).toBe('До приезда скорой не назначено: гепарин натрия в вену');
    expect(scoreOf(p, ['tx.heparin_iv'], 'ambulance').score.treatment).toBe('A');
    const home = scoreOf(p, ['tx.doac', 'tx.compression'], 'home');
    expect(home.ev.setting).toMatchObject({ chosen: 'home', recommended: 'transfer' });
    expect(home.score.setting).toBe('D');
  });

  test('УЗИ артерий: в карте — тот же срез бедра, артерия закрыта; гепарин — в «Сердце и сосуды»', () => {
    const p = people(ALI, 1)[0];
    const US = 'exam.us_leg_arteries';
    const image = (obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: [{ exam: US, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [US],
      draft: { treatments: [], setting: 'home' }, departments: ED,
    }).groups.find(g => g.exam === US)!.image;
    expect(image([ob(US, 'img.us_artery_occluded', true)])).toMatchObject({ kind: 'us', view: 'vein', arterial: 1 });
    expect(image([ob(US, 'img.us_artery_occluded', false)])).toMatchObject({ kind: 'us', view: 'vein', arterial: 0 });
    expect(db.exams[US]).toMatchObject({ room: 'room.ultrasound', complaints: ['sym.leg_pain'] });
    const groups = Object.fromEntries(treatmentGroupsFor([]).map(g => [g.key, g.items.map(x => x.id)]));
    expect(groups.heart).toEqual(expect.arrayContaining(['tx.heparin_iv', 'tx.epinephrine_im']));
  });

  test('ЭКГ с фибрилляцией предсердий в карте — неправильный ритм', () => {
    const p = people(ALI, 1)[0];
    const ECG = 'exam.ecg';
    const image = (obs: Observation[]) => makeCaseView({
      version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: [{ exam: ECG, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [ECG],
      draft: { treatments: [], setting: 'home' }, departments: ED,
    }).groups.find(g => g.exam === ECG)!.image;
    expect(image([ob(ECG, 'ecg.af', true)])).toMatchObject({ kind: 'ecg', ecg: { rhythm: 'af' } });
    expect(image([ob(ECG, 'ecg.af', false)])).not.toHaveProperty('ecg.rhythm');
  });
});

describe('анафилактический шок', () => {
  test('запись: терапия, «Сердце и сосуды», критическое; эпинефрин — первая линия; перевод', () => {
    expect(db.conditions[ANA]).toMatchObject({ department: 'dept.therapy', system: 'heart', severity: 'critical', icd10: 'T78.2', confirm: 'clinical' });
    expect(db.conditions[ANA].sources.map(s => s.url)).toContain('https://cr.minzdrav.gov.ru/view-cr/263_2');
    expect(txRole(db, ANA, 'tx.epinephrine_im')).toBe('firstLine');
    for (const tx of ['tx.iv_fluids', 'tx.steroid_iv', 'tx.antihistamine_parenteral', 'tx.salbutamol']) expect(txRole(db, ANA, tx)).toBe('supportive');
    for (const tx of ['tx.antihistamine', 'tx.steroid_systemic_short']) expect(txRole(db, ANA, tx)).toBe('notIndicated');
    expect(db.treatments['tx.epinephrine_im']).toMatchObject({ route: 'im', class: 'adrenergic.epinephrine' });
  });

  test('причина — параметр: лекарство, пища, ужаление, не установлена — 40 : 25 : 20 : 15; расспрос её узнаёт', () => {
    const xs = people(ANA, 2000, 1, undefined, ['dept.therapy']);
    near(share(xs, p => params(p).trigger === 'drug'), 0.4, 0.035);
    near(share(xs, p => params(p).trigger === 'food'), 0.25, 0.035);
    near(share(xs, p => params(p).trigger === 'sting'), 0.2, 0.035);
    const what: Record<string, Id> = { drug: 'hx.trigger_drug', food: 'hx.trigger_food', sting: 'hx.trigger_sting' };
    // своя причина — у каждого; чужая — только фоном: укол или орехи бывают и без аллергии
    let other = 0;
    for (const p of xs.slice(0, 300)) {
      for (const [t, f] of Object.entries(what)) {
        if (params(p).trigger === t) expect(has(p, f)).toBe(true);
        else if (has(p, f)) other++;
      }
      const obs = runExam(db, p, 'exam.ask_reaction', Rng.seeded(p.seed), undefined, true);
      const told = what[params(p).trigger];
      if (told) expect(obs.find(o => o.f === told)!.shown).toBe(true);
    }
    expect(other / 900).toBeLessThan(0.06);
    expect(db.exams['exam.ask_reaction'].routineFor).toEqual(['sym.hives']);
  });

  test('«виртуальный врач» в поликлинике и в приёмном: эпинефрин и скорая у 90 % и больше', () => {
    for (const departments of [['dept.therapy'], ED]) {
      const runs = people(ANA, 60, 3000, undefined, departments).map(p => ({ p, r: doctor(p, departments) }));
      expect(share(runs, x => x.r.correct)).toBeGreaterThan(0.9);
      expect(share(runs, x => x.r.plan.setting === 'ambulance' && x.r.plan.treatments.includes('tx.epinephrine_im'))).toBeGreaterThan(0.9);
    }
  });

  test('оценка: антигистаминные и гормоны вместо эпинефрина — «до приезда скорой не назначено: эпинефрин»', () => {
    const p = people(ANA, 1, 11, undefined, ['dept.therapy'])[0];
    const wrong = scoreOf(p, ['tx.antihistamine_parenteral', 'tx.steroid_iv'], 'ambulance');
    expect(wrong.score.notes.some(n => n.code === 'tx.preHospitalMissing' && n.tx === 'tx.epinephrine_im')).toBe(true);
    expect(wrong.score.treatment).toBe('B');
    expect(scoreOf(p, ['tx.epinephrine_im', 'tx.iv_fluids', 'tx.steroid_iv'], 'ambulance').score.treatment).toBe('A');
    // оставить дома — место «D», красные флаги не увидели — вред
    expect(scoreOf(p, ['tx.epinephrine_im'], 'home').score.setting).toBe('D');
  });

  test('статья: первая линия — эпинефрин, лечат не дома; красные флаги — низкое давление, стридор, отёк; спутать — с ОКС', () => {
    const a = article(db, ANA)!;
    const rows = a.blocks.find(b => b.key === 'treatment')!.rows!;
    expect(rows.find(r => r.label === 'Первая линия')!.refs!.map(r => r.id)).toEqual(['tx.epinephrine_im']);
    expect(a.blocks.find(b => b.key === 'where')!.text![0]).toContain('скорая');
    expect(a.blocks.find(b => b.key === 'redFlags')!.refs!.map(r => r.id).sort()).toEqual([LOW, 'sign.angioedema', 'sign.stridor'].sort());
    expect(a.blocks.find(b => b.key === 'course')!.text![0]).toContain('в тот же день');
    expect(similar(db, ANA)[0]).toBe('cond.acs');
  });
});

describe('носовое кровотечение', () => {
  test('запись: терапия, «Простуда, горло и нос»; источник 70 : 20 : 10; у каждого — жалоба на кровь из носа', () => {
    expect(db.conditions[NOSE]).toMatchObject({ department: 'dept.therapy', system: 'airways', severity: 'moderate', icd10: 'R04.0', confirm: ['exam.nose_exam'] });
    expect(db.conditions[NOSE].sources.map(s => s.url)).toContain('https://cr.minzdrav.gov.ru/view-cr/977_1');
    const xs = people(NOSE, 2000, 1, undefined, ['dept.therapy']);
    near(share(xs, p => params(p).source === 'anterior_visible'), 0.7, 0.035);
    near(share(xs, p => params(p).source === 'posterior'), 0.1, 0.025);
    for (const p of xs.slice(0, 400)) {
      expect(p.complaints).toContain('sym.nosebleed');
      expect(has(p, 'sign.nasal_bleeding_point')).toBe(params(p).source === 'anterior_visible');
      expect(has(p, 'sign.blood_pharynx')).toBe(params(p).source === 'posterior');
    }
    // осмотр носа, зева, давление и лекарства — каждому с кровью из носа
    for (const e of ['exam.nose_exam', 'exam.throat', 'exam.vitals', 'exam.ask_meds']) expect(db.exams[e].routineFor).toContain('sym.nosebleed');
  });

  test('тактика по источнику: видно — турунда, не видно — передняя тампонада, сзади — перевод', () => {
    const t = db.conditions[NOSE].treatment!;
    expect(tacticsFor(t, { source: 'anterior_visible' }).firstLine).toEqual(['tx.nasal_turunda']);
    expect(tacticsFor(t, { source: 'anterior_hidden' }).firstLine).toEqual(['tx.anterior_packing']);
    expect(tacticsFor(t, { source: 'posterior' }).firstLine).toEqual([]);
    const [visible, hidden, posterior] = (['anterior_visible', 'anterior_hidden', 'posterior'] as const).map(source => people(NOSE, 1, 3, { source }, ['dept.therapy'])[0]);
    expect([visible, hidden, posterior].map(p => recommendedSetting(db, p))).toEqual(['home', 'home', 'transfer']);
    // турунда при невидимом источнике причину не лечит; сзади — до приезда скорой прижать крылья или тампонада
    expect(scoreOf(hidden, ['tx.nasal_turunda'], 'home').score.notes.some(n => n.code === 'tx.noCure')).toBe(true);
    expect(scoreOf(hidden, ['tx.anterior_packing', 'tx.nose_pinch'], 'home').score.treatment).toBe('A');
    expect(scoreOf(posterior, [], 'ambulance').score.notes.some(n => n.code === 'tx.preHospitalMissing')).toBe(true);
    expect(scoreOf(posterior, ['tx.nose_pinch'], 'ambulance').score.treatment).toBe('A');
  });

  test('«виртуальный врач»: видимый источник — турунда дома, задний — скорая; осмотр носа и зева — каждому', () => {
    const runs = (source: string, n: number) => people(NOSE, n, 4000, { source }, ['dept.therapy']).map(p => ({ p, r: doctor(p, ['dept.therapy']) }));
    const visible = runs('anterior_visible', 50);
    const posterior = runs('posterior', 40);
    for (const x of [...visible, ...posterior]) {
      expect(x.r.correct).toBe(true);
      for (const e of ['exam.nose_exam', 'exam.throat', 'exam.vitals']) expect(x.r.exams).toContain(e);
    }
    expect(share(visible, x => x.r.plan.setting === 'home' && x.r.plan.treatments.includes('tx.nasal_turunda'))).toBeGreaterThan(0.8);
    expect(share(posterior, x => x.r.plan.setting === 'ambulance')).toBeGreaterThan(0.75);
  });
});
