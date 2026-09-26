// «Виртуальный врач» (`docs/05-content.md` §6, `docs/09-testing.md` §3): три стратегии,
// которыми проверяется база. Разумный врач потом станет нанятым врачом (`03` §8).
import type { ContentDb, Id, Setting } from '../../content/types';
import { Rng } from '../core/rng';
import { complaintObservations, runExam } from './exams';
import { type Belief, expectedGain, knownFacts, posterior } from './infer';
import { type Plan, SETTING_ORDER } from './plan';
import type { Observation, Patient } from './types';

export type Strategy = 'rational' | 'lazy' | 'shotgun';

export interface DoctorResult {
  diagnosis: Id;
  correct: boolean;
  /** верно с точностью до группы с одинаковой тактикой */
  correctGroup: boolean;
  /** уверенность в поставленном диагнозе в момент решения */
  confidence: number;
  exams: Id[];
  money: number;
  minutes: number;
  /** план лечения, который врач выбрал бы для своего диагноза */
  plan: Plan;
  /** всё, что врач узнал: жалобы и результаты */
  observations: Observation[];
}

export interface DoctorOptions {
  candidates: Id[];
  exams: Id[];
  /** при какой уверенности разумный врач ставит диагноз; 0,9 — по прогону прототипа (spec 2026-09-spikes) */
  threshold?: number;
  /** польза ниже этой (биты) — обследование не назначается */
  minGain?: number;
}

/** Цена обследования в условных единицах: минуты, деньги, неприятность, облучение. */
export function examCost(db: ContentDb, id: Id): number {
  const e = db.exams[id];
  const minutes = e.time.procedure + (e.time.report ?? 0) + (e.time.turnaround ?? 0) * 0.25;
  const radiation = e.radiation === 'high' ? 40 : e.radiation === 'medium' ? 20 : e.radiation === 'low' ? 8 : 0;
  return minutes + e.cost / 100 + e.discomfort * 5 + radiation;
}

/**
 * Пользу сравниваем после округления: в ней логарифм, а его последний бит в Hermes, V8 и
 * JSC может разниться. Разница порядка 1e-16 не должна менять выбор врача (ADR 0004).
 */
const quantize = (x: number) => Math.round(x * 1e9);

/** Может ли у этого человека быть фактор риска (по полу и возрасту). */
function possibleFor(db: ContentDb, id: Id, patient: Patient): boolean {
  const r = db.risks[id];
  if (!r) return true;
  return r.p[patient.sex] > 0 && patient.age >= (r.ageMin ?? 0) && patient.age <= (r.ageMax ?? 200);
}

/** Обследования, которые открывают противопоказание (вопрос об аллергиях), — самое дешёвое. */
function askingExam(db: ContentDb, contraindication: Id): Id | undefined {
  const telling = (db.risks[contraindication]?.findings ?? db.conditions[contraindication]?.findings ?? [])
    .map(l => l.f).filter(f => f.startsWith('hx.'));
  const exams = [...new Set(telling.flatMap(f => db.revealedBy[f] ?? []))];
  return exams.sort((a, b) => examCost(db, a) - examCost(db, b) || (a < b ? -1 : 1))[0];
}

/**
 * План для своего диагноза: препарат выбора без известных противопоказаний (иначе
 * первая допустимая замена) и место лечения — по умолчанию или выше, если врач видел
 * красный флаг этого состояния.
 */
export function choosePlan(db: ContentDb, diagnosis: Id, observations: readonly Observation[]): Plan {
  const t = db.conditions[diagnosis]?.treatment;
  if (!t) return { treatments: [], setting: 'home' };
  const known = knownFacts(db, observations);
  const blocked = new Set([...known.risks, ...known.conditions]);
  const ok = (tx: Id) => !db.treatments[tx].contraindications.some(k => blocked.has(k.id));
  const cures = (tx: Id) => db.treatments[tx].effects.some(e => e.on === diagnosis && e.kind === 'cure');
  // типичное назначение; если противопоказание убрало лечение причины — замена из первой линии и допустимых
  const treatments = (t.plan ?? t.firstLine).filter(ok);
  if (!treatments.some(cures)) {
    const alt = [...t.firstLine, ...t.acceptable].filter(ok).find(cures);
    if (alt && (t.plan ?? t.firstLine).some(cures)) treatments.push(alt);
  }
  const seen = new Set(observations.filter(o => o.shown).map(o => o.f));
  let setting = t.setting.default;
  const raise = (s: Setting) => {
    if (SETTING_ORDER[s] > SETTING_ORDER[setting]) setting = s;
  };
  if (t.setting.redFlag && (db.conditions[diagnosis].redFlags ?? []).some(f => seen.has(f))) raise(t.setting.redFlag);
  for (const r of t.setting.risks ?? []) if (known.risks.includes(r.id)) raise(r.setting);
  return { treatments: [...new Set(treatments)].sort(), setting };
}

export function runDoctor(db: ContentDb, patient: Patient, strategy: Strategy, rng: Rng, opt: DoctorOptions): DoctorResult {
  const threshold = opt.threshold ?? 0.9;
  const minGain = opt.minGain ?? 0.02;
  const obs: Observation[] = complaintObservations(patient);
  const done: Id[] = [];
  const ctxOf = () => {
    const known = knownFacts(db, obs);
    return { sex: patient.sex, age: patient.age, season: patient.season, knownRisks: known.risks, knownConditions: known.conditions };
  };
  const doExam = (id: Id) => {
    obs.push(...runExam(db, patient, id, rng.fork(`exam:${done.length}:${id}`)));
    done.push(id);
  };

  let beliefs: Belief[] = posterior(db, opt.candidates, obs, ctxOf());
  if (strategy === 'shotgun') {
    for (const id of opt.exams) doExam(id);
    beliefs = posterior(db, opt.candidates, obs, ctxOf());
  } else if (strategy === 'rational') {
    // анамнез жизни спрашивают у всех: польза вопроса о хронических болезнях в модели не
    // видна (сопутствующие считаются известными), а без него обострение ХОБЛ не узнать
    for (const id of opt.exams) if (db.exams[id].routine) doExam(id);
    beliefs = posterior(db, opt.candidates, obs, ctxOf());
    for (let step = 0; step < opt.exams.length; step++) {
      if (beliefs[0].p >= threshold) break;
      const ctx = ctxOf();
      const observed = new Set(obs.map(o => o.f));
      let best: Id | undefined;
      let bestScore = 0;
      for (const id of opt.exams) {
        if (done.includes(id)) continue;
        const gain = expectedGain(db, id, beliefs, ctx, observed);
        if (quantize(gain) < quantize(minGain)) continue;
        const score = quantize(gain / examCost(db, id));
        if (score > bestScore) {
          bestScore = score;
          best = id;
        }
      }
      if (!best) break;
      doExam(best);
      beliefs = posterior(db, opt.candidates, obs, ctxOf());
    }
  }

  const top = beliefs[0];
  // Перед лечением с противопоказаниями разумный врач спрашивает о них (об аллергиях — перед
  // антибиотиком); ленивый — нет; «всё подряд» уже спросил всё.
  let plan = choosePlan(db, top.id, obs);
  if (strategy === 'rational') {
    const risks = [...new Set(plan.treatments.flatMap(tx => db.treatments[tx].contraindications.map(k => k.id)))].sort();
    for (const k of risks) {
      if (!possibleFor(db, k, patient)) continue; // о беременности не спрашивают мужчину и женщину 64 лет
      const ask = askingExam(db, k);
      if (ask && !done.includes(ask) && opt.exams.includes(ask)) doExam(ask);
    }
    plan = choosePlan(db, top.id, obs);
  }
  const primary = patient.truth.conditions.find(c => c.role === 'primary')!.id;
  const money = done.reduce((a, id) => a + db.exams[id].cost, 0);
  const minutes = done.reduce((a, id) => a + db.exams[id].time.procedure + (db.exams[id].time.report ?? 0) + (db.exams[id].time.turnaround ?? 0), 0);
  const group = (id: Id) => db.conditions[id]?.group ?? id;
  return { diagnosis: top.id, correct: top.id === primary, correctGroup: group(top.id) === group(primary), confidence: top.p, exams: done, money, minutes, plan, observations: obs };
}
