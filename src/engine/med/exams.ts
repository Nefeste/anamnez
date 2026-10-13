// Обследование открывает признаки — и ошибается так, как ошибаются в жизни
// (`docs/04-medical-model.md` §5): у каждой пары «обследование — признак» своя
// чувствительность и специфичность, поправленные навыком и оборудованием.
import type { Condition, ContentDb, Exam, ExamCheck, Id } from '../../content/types';
import { P_ONE, Rng } from '../core/rng';
import { sampleRange } from './generate';
import type { Observation, Patient } from './types';

/**
 * Поправки точности: множители к чувствительности и специфичности (1 — как в базе) и
 * добавки в процентных пунктах — аппарат и навык рентгенолога (spec 2026-09-own-hospital).
 */
export interface ExamSkill {
  sens: number;
  spec: number;
  sensPp?: number;
  specPp?: number;
}

export const NORMAL_SKILL: ExamSkill = { sens: 1, spec: 1 };

/** Навык и аппарат не делают из аускультации КТ: поправленная точность — в [0,5; 0,995]. */
const clampP = (p: number) => Math.max(5000, Math.min(9950, Math.round(p)));

export function effectiveCheck(sens: number, spec: number, skill: ExamSkill): { sens: number; spec: number } {
  const sp = skill.sensPp ?? 0;
  const cp = skill.specPp ?? 0;
  return {
    sens: skill.sens === 1 && sp === 0 ? sens : clampP(sens * skill.sens + sp * 100),
    spec: skill.spec === 1 && cp === 0 ? spec : clampP(spec * skill.spec + cp * 100),
  };
}

/**
 * Во столько раз реже ложная находка осмотра, снимка и ЭКГ у того, кому они не показаны по жалобам (вопрос 33, игровая
 * оценка): их специфичность в рекомендациях измерена у больных с подозрением на болезнь, а ложную находку у таких больных
 * чаще всего дают похожие болезни — у человека с кашлем симптома Мерфи почти не бывает.
 */
export const UNEXPECTED_FALSE = 5;

/** Осмотр, снимки и ЭКГ: их точность — у больных с подозрением (вопрос 33); анализы и вопросы ошибаются у всех одинаково. */
export const BY_COMPLAINT: ReadonlySet<Exam['kind']> = new Set(['physical', 'imaging', 'functional']);

const signSetsCache = new WeakMap<Condition, Set<Id>[]>();

/**
 * Признаки болезни при каждом сочетании скрытых параметров, от которых они зависят: сепсис из лёгких даёт кашель, из
 * брюшной полости — симптом Мерфи, но не оба сразу. Без таких параметров — один набор.
 */
function signSets(c: Condition): Set<Id>[] {
  const cached = signSetsCache.get(c);
  if (cached) return cached;
  const names = [...new Set(c.findings.flatMap(l => Object.keys(l.when ?? {})))].filter(n => c.params?.[n]).sort();
  let combos: Record<string, string>[] = [{}];
  for (const n of names) combos = combos.flatMap(k => Object.entries(c.params![n]).filter(([, w]) => w > 0).map(([v]) => ({ ...k, [n]: v })));
  const holds = (when: Record<string, string[]> | undefined, k: Record<string, string>) => !when || Object.entries(when).every(([p, allowed]) => !c.params?.[p] || allowed.includes(k[p]));
  const out = combos.map(k => new Set(c.findings.filter(l => l.p > 0 && holds(l.when, k)).map(l => l.f)));
  signSetsCache.set(c, out);
  return out;
}

/**
 * Признаки того, без чего болезнь не бывает, и её факторов риска: их ищут вместе с ней — камни на УЗИ при желчной колике,
 * фибрилляцию предсердий на ЭКГ при инсульте, варикоз при тромбозе вен.
 */
function backgroundSigns(db: ContentDb, c: Condition): Id[] {
  const out: Id[] = [];
  for (const id of [...(c.requires ?? []), ...(c.risks ?? []).map(r => r.id)]) {
    for (const l of db.risks[id]?.findings ?? []) if (l.p > 0) out.push(l.f);
    const chronic = db.conditions[id];
    if (chronic) for (const signs of signSets(chronic)) out.push(...signs);
  }
  return out;
}

const expectedCache = new WeakMap<ContentDb, Map<string, ReadonlySet<Id>>>();

/**
 * Находки, которых ждут по жалобам (вопрос 33): признаки болезней, которые объясняют жалобы пациента, — все, кроме, может
 * быть, последней из нескольких: о главном говорят первым, а последним — о том, что ноет и без болезни; и признаки того,
 * без чего такие болезни не бывают, и их факторов риска (`backgroundSigns`). Пришёл без жалоб, на профосмотр, — не ждут
 * ничего. Только по базе и жалобам: у движка и у вывода — один и тот же набор.
 */
export function expectedFindings(db: ContentDb, complaints: readonly Id[]): ReadonlySet<Id> {
  let byDb = expectedCache.get(db);
  if (!byDb) expectedCache.set(db, (byDb = new Map()));
  const key = complaints.join(' ');
  let out = byDb.get(key);
  if (!out) {
    const need = complaints.length > 1 ? complaints.slice(0, -1) : complaints;
    const set = new Set<Id>();
    if (need.length > 0) {
      for (const id of Object.keys(db.conditions).sort()) {
        const c = db.conditions[id];
        let explains = false;
        for (const signs of signSets(c)) {
          if (!need.every(f => signs.has(f))) continue;
          explains = true;
          for (const f of signs) set.add(f);
        }
        if (explains) for (const f of backgroundSigns(db, c)) set.add(f);
      }
    }
    byDb.set(key, (out = set));
  }
  return out;
}

/**
 * Вероятность ложной находки (из `P_ONE`) при специфичности `spec`: как в рекомендации — у того, кому осмотр, снимок или
 * ЭКГ показаны по жалобам (находку ждут, `expectedFindings`), у остальных — в `UNEXPECTED_FALSE` раз реже (вопрос 33).
 */
export function falseRate(exam: Pick<Exam, 'kind'>, f: Id, spec: number, expected: ReadonlySet<Id>): number {
  const p = P_ONE - spec;
  return BY_COMPLAINT.has(exam.kind) && !expected.has(f) ? Math.round(p / UNEXPECTED_FALSE) : p;
}

/**
 * Подходит ли обследование пациенту — по полу и возрасту из базы: о месячных и беременности
 * не спрашивают мужчину и женщину 73 лет. С части 32г — и по жалобе: о травме головы спрашивают
 * пришедших с травмой головы, а не с пиелонефритом ради вопроса о рвоте. Не подходит — его нет в
 * карте пациента, движок его не делает, «виртуальный врач» не назначает.
 */
export function examFits(exam: Exam, patient: Pick<Patient, 'sex' | 'age' | 'complaints'>): boolean {
  return (exam.sex === undefined || exam.sex === patient.sex)
    && (exam.ageMin === undefined || patient.age >= exam.ageMin)
    && (exam.ageMax === undefined || patient.age <= exam.ageMax)
    && (exam.complaints === undefined || exam.complaints.some(f => patient.complaints.includes(f)));
}

/**
 * Проводит обследование. `rng` — ветвь именно этого назначения (например,
 * `root.fork('order:12')`): повторное обследование бросает новые монеты. `exact` — без
 * ошибок: показывает правду (сложность «Студент», 03-game-design.md §14). Ложная находка
 * осмотра, снимка и ЭКГ, не показанных по жалобам, — реже (`falseRate`, вопрос 33).
 */
export function runExam(db: ContentDb, patient: Patient, examId: Id, rng: Rng, skill: ExamSkill = NORMAL_SKILL, exact = false): Observation[] {
  const exam = db.exams[examId];
  if (!exam) throw new Error(`runExam: unknown exam ${examId}`);
  const present = new Map(patient.truth.findings.map(x => [x.f, x]));
  // О том, на что пациент пожаловался сам, не переспрашивают: ответ уже известен без ошибки.
  const told = new Set(patient.complaints);
  const expected = expectedFindings(db, patient.complaints);
  const checks = exam.checks.filter(check => !told.has(check.f));
  // одно число на две находки (часть 41в): ошиблись в объёме гематомы — полушарие то же, что у неё
  const twinAttrs = (f: Id) => patient.truth.findings.find(x => x.attrs && (db.findings[x.f]?.value?.of === f || db.findings[f].value?.of === x.f))?.attrs;
  const observe = (check: ExamCheck): Observation => {
    const r = rng.fork(check.f);
    const truth = present.get(check.f);
    const { sens, spec } = exact ? { sens: P_ONE, spec: P_ONE } : effectiveCheck(check.sens, check.spec, skill);
    const shown = truth ? r.chance(sens) : r.chance(falseRate(exam, check.f, spec, expected));
    const finding = db.findings[check.f];
    const obs: Observation = { f: check.f, shown, exam: examId };
    if (finding.value) {
      // Верный результат показывает истинное значение, ложный — значение из «чужого» диапазона.
      obs.value = shown === Boolean(truth)
        ? patient.truth.values[check.f]
        : sampleRange(r.fork('value'), shown ? finding.value.present : finding.value.absent, finding.value.decimals);
    }
    if (shown && finding.attrs) {
      obs.attrs = truth?.attrs ?? twinAttrs(check.f) ?? Object.fromEntries(Object.keys(finding.attrs).sort().map(a => [a, r.fork(a).pick(Object.keys(finding.attrs![a]).sort())]));
    }
    return obs;
  };
  // порог на чужом измерении (часть 33б) — после того, чьё измерение: низкое давление показывает то
  // же число, что тонометр, и «есть» — если число попало в его диапазон
  const measured = new Map<Id, Observation>();
  // уточнение (часть 41в): не показан признак, после которого проверяют, — проверки нет, и порога
  // на её числе тоже: объёма гематомы без крови на КТ не пишут
  const skipped = new Set<Id>();
  const shared = (check: ExamCheck) => db.findings[check.f].value?.of !== undefined;
  for (const check of [...checks.filter(c => !shared(c)), ...checks.filter(shared)]) {
    const spec = db.findings[check.f].value;
    if ((check.given !== undefined && measured.get(check.given)?.shown !== true) || (spec?.of !== undefined && skipped.has(spec.of))) {
      skipped.add(check.f);
      continue;
    }
    const base = spec?.of ? measured.get(spec.of) : undefined;
    if (spec && base?.value !== undefined) {
      const shown = base.value >= spec.present[0] && base.value <= spec.present[1];
      const obs: Observation = { f: check.f, shown, value: base.value, exam: examId };
      // атрибут (часть 41в): гематома больше 30 см³ — в своём полушарии, как и до 30
      const finding = db.findings[check.f];
      if (shown && finding.attrs) {
        const r = rng.fork(check.f);
        obs.attrs = present.get(check.f)?.attrs ?? twinAttrs(check.f) ?? Object.fromEntries(Object.keys(finding.attrs).sort().map(a => [a, r.fork(a).pick(Object.keys(finding.attrs![a]).sort())]));
      }
      measured.set(check.f, obs);
      continue;
    }
    measured.set(check.f, observe(check));
  }
  return checks.filter(check => measured.has(check.f)).map(check => measured.get(check.f)!);
}

/** Жалобы, которые пациент называет сам, — наблюдения без ошибок. */
export function complaintObservations(patient: Patient): Observation[] {
  const present = new Map(patient.truth.findings.map(x => [x.f, x]));
  return patient.complaints.map(f => {
    const attrs = present.get(f)?.attrs;
    return attrs ? { f, shown: true, attrs, exam: 'complaint' } : { f, shown: true, exam: 'complaint' };
  });
}
