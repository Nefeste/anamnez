// «Разобрать случай» (spec 2026-10-study-case, часть 74): из статьи болезни — приём одного больного там, где её лечат.
// Приём — тот же, что у «Случая дня» (`createVisit`), но в больнице из статьи: её отделения, места, обследования и
// смотровая приёмного. Без записи: у приёма нет `onFinish` — ни профиля, ни рекордов, ни достижений, ни архива.
import { useSyncExternalStore } from 'react';
import { db } from '@/content';
import type { Id, Season } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { likelyParams } from '@/engine/med/infer';
import type { Observation, Patient } from '@/engine/med/types';
import { type OrBlock, orBlock } from '@/engine/shift/engine';
import { STUDY_CLINIC, studyPatient, studyPlace, type StudyPlace } from '@/engine/shift/study';
import { operationFor } from '@/engine/shift/surgery';
import { T } from '@/i18n';
import type { SettingOption } from './caseView';
import { examBlockText, problemText } from './sandboxView';
import { createVisit, type VisitPlace, type VisitView } from './visit';

const visit = createVisit(fnv1a('study'));

/** Болезнь открытого случая. */
let open: Id | undefined;

/** Сезон — по месяцу, как у «Смены». */
function seasonNow(d = new Date()): Season {
  const m = d.getMonth();
  return m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}

/** Где будет больной этой болезни — для строки под кнопкой; с ней не приходят — кнопки нет. */
export function studyWhere(id: Id): string | undefined {
  const p = studyPlace(db, id);
  return p && (T.study.where[p.venue] ?? db.presets[p.venue]?.name.ru);
}

/** Можно ли разобрать случай этой болезни — без расчёта больницы: с ней приходят на приём. */
export const studyable = (id: Id): boolean => db.conditions[id]?.presenting === true;

/** Новый случай: больной этой болезни в её больнице. С ней не приходят — нет. */
export function openStudy(id: Id, seed = Date.now() % 0x7fffffff): boolean {
  const p = studyPlace(db, id);
  if (!p) return false;
  open = id;
  visit.start(seed >>> 0, seasonNow(), placeOf(id, p));
  return true;
}

/** Ещё один больной той же болезни: другое зерно. */
export function studyAgain(): void {
  if (open) openStudy(open, (visit.seed() + 0x9e37) % 0x7fffffff);
}

/** Болезнь открытого случая — «К статье». */
export const studyCondition = (): Id | undefined => open;

export const studyVisit = visit;

export function useStudy(): VisitView {
  return useSyncExternalStore(visit.subscribe, visit.view, visit.view);
}

function placeOf(id: Id, p: StudyPlace): VisitPlace {
  const ambulance = db.conditions[id].arrival === 'ambulance';
  const hospital = p.venue !== STUDY_CLINIC;
  return {
    patient: (seed, season) => studyPatient(db, id, p, seed, season),
    departments: p.departments,
    ...(hospital ? { settings: (dx: Id | undefined, obs: readonly Observation[], patient: Patient) => settingsHere(p, dx, obs, patient), operation: operationOf } : {}),
    unavailable: Object.fromEntries(Object.entries(p.blocked).map(([exam, b]) => [exam, examBlockText(db, b)])),
    bedside: p.bedside,
    rooms: p.rooms,
    ...(p.ricu ? { ricu: true } : {}),
    ...(ambulance ? { ambulance: true } : {}),
    notes: [...(ambulance ? [T.study.paramedic] : []), ...(p.bedside.length > 0 ? [T.study.bay] : [])],
  };
}

/** Операция поставленного диагноза — по тому, что видно (часть 32б), как при закрытии случая на смене. */
const operationOf = (dx: Id, obs: readonly Observation[], patient: Patient): Id | undefined => operationFor(db, dx, likelyParams(db, dx, obs, patient));

/**
 * Где лечить в больнице из статьи — как на смене в ней (`settingOptions` смены): домой, в палату, в ПИТ, в реанимацию, в
 * бокс, в операционную, направить, скорая. Коек не считаем: больной один, места есть.
 */
function settingsHere(p: StudyPlace, diagnosis: Id | undefined, obs: readonly Observation[], patient: Patient): SettingOption[] {
  const t = T.shift.ward;
  const setting = T.spikes.patient.setting;
  return [
    { key: 'home', title: setting.home },
    ...(p.ward ? [{ key: 'admit' as const, title: t.admit }] : []),
    ...(p.icu ? [{ key: 'icu' as const, title: t.icu }] : []),
    ...(p.ricu ? [{ key: 'ricu' as const, title: t.ricu }] : []),
    ...(p.box ? [{ key: 'box' as const, title: t.box }] : []),
    ...(p.or ? [orOption(p, diagnosis, obs, patient)] : []),
    { key: 'ward', title: t.refer },
    { key: 'ambulance', title: setting.ambulance },
  ];
}

/** «В операционную»: операция диагноза; нельзя — почему (часть 28). */
function orOption(p: StudyPlace, diagnosis: Id | undefined, obs: readonly Observation[], patient: Patient): SettingOption {
  const t = T.shift.ward;
  const op = diagnosis ? operationOf(diagnosis, obs, patient) : undefined;
  const block = op ? orBlock(db, p.state, op) : null;
  const why = !diagnosis ? t.noDiagnosis : !op ? t.noOperation : block ? orBlockText(block) : undefined;
  return why ? { key: 'surgery', title: t.operate, hint: why, disabled: true } : { key: 'surgery', title: t.operate, hint: db.treatments[op!].name.ru };
}

function orBlockText(b: OrBlock): string {
  const t = T.shift.ward;
  if (b.kind === 'noEquipment') return t.noOpEquipment(db.equipment[b.equipment]?.gen.ru ?? b.equipment);
  if (b.kind === 'down') return t.orDown(problemText(db, b.problem));
  return t.orDown(T.sandbox.problem.noEquipment);
}
