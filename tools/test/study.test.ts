// «Разобрать случай» (spec 2026-10-study-case, часть 74): из статьи — один больной с болезнью там, где её лечат: в
// амбулатории или в первой больнице глав, где её лечат целиком. Приём — как у «Случая дня», но в этой больнице; в
// профиль, рекорды, достижения и архив он не идёт.
import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import { membersOf, type Tactics } from '../../src/content/types';
import { bedsideLack } from '../../src/engine/med/plan';
import { placeVenue, STUDY_CLINIC, studyPatient, studyPlace, studyVenues } from '../../src/engine/shift/study';
import { T } from '../../src/i18n';
import { forgetProfile, loadProfile, profile, setProfileStore } from '../../src/state/profile';
import { memoryStore } from '../../src/state/saves';
import { openStudy, studyAgain, studyCondition, studyVisit, studyWhere } from '../../src/state/study';

// больницы «Смены» строятся один раз на базу — первый вызов дольше 5 секунд не бывает, но больных — каждой болезни
setDefaultTimeout(60_000);

const presenting = Object.values(db.conditions).filter(c => c.presenting);
const venue = (id: string) => studyPlace(db, id)?.venue;
const treatments = (t: Tactics) =>
  [t, ...(t.byParam ?? [])].flatMap(x => [...x.firstLine, ...x.acceptable, ...x.supportive, ...(x.plan ?? []), ...(x.preHospital ?? []), ...membersOf(x.require), ...membersOf(x.beforeTransfer)]);

describe('где разобрать случай', () => {
  test('амбулатория и больницы глав с приёмным — по порядку глав', () => {
    expect(studyVenues(db)).toEqual(['preset.clinic', 'preset.district', 'preset.vascular', 'preset.city']);
  });

  test('у болезни, с которой приходят, — место с её отделением и приёмным для привезённых скорой; с которой не приходят — нет', () => {
    for (const c of presenting) {
      const p = studyPlace(db, c.id)!;
      expect({ id: c.id, department: p.departments.includes(c.department), bay: c.arrival !== 'ambulance' || p.bedside.length > 0 })
        .toEqual({ id: c.id, department: true, bay: true });
    }
    for (const c of Object.values(db.conditions).filter(x => !x.presenting)) expect(studyPlace(db, c.id)).toBeUndefined();
  });

  test('амбулатория — только терапия, которую обычно лечат дома, с которой приходят сами и без аппаратов у постели', () => {
    const clinic = studyPlace(db, 'cond.arvi')!;
    const here = presenting.filter(c => venue(c.id) === STUDY_CLINIC);
    expect(here.length).toBeGreaterThan(20);
    for (const c of here) {
      expect({ id: c.id, department: c.department, home: c.treatment?.setting.default, arrival: c.arrival, lack: treatments(c.treatment!).filter(tx => bedsideLack(db, tx, placeVenue(clinic))) })
        .toEqual({ id: c.id, department: 'dept.therapy', home: 'home', arrival: undefined, lack: [] });
    }
  });

  test('больница — где все лечение тактики есть у постели и в кабинетах; кроме самой большой, у неё и всех мест хватает', () => {
    for (const c of presenting.filter(x => venue(x.id) !== STUDY_CLINIC && venue(x.id) !== 'preset.city')) {
      const p = studyPlace(db, c.id)!;
      expect({ id: c.id, lack: treatments(c.treatment!).filter(tx => bedsideLack(db, tx, placeVenue(p))) }).toEqual({ id: c.id, lack: [] });
    }
  });

  test('примеры: ОРВИ и крапивница — в амбулатории, аппендицит — в районной, инсульт и кетоацидоз — с сосудистым отделением, менингококковая инфекция — в городской', () => {
    expect(['cond.arvi', 'cond.urticaria_acute', 'cond.appendicitis', 'cond.stroke_ischemic', 'cond.dka', 'cond.meningococcal'].map(venue))
      .toEqual(['preset.clinic', 'preset.clinic', 'preset.district', 'preset.vascular', 'preset.vascular', 'preset.city']);
    expect(studyWhere('cond.stroke_ischemic')).toBe('в районной больнице с сосудистым отделением');
    expect(studyWhere('cond.hypertension')).toBeUndefined();
  });
});

describe('больной', () => {
  test('у каждой болезни, с которой приходят, — больной с ней', () => {
    for (const c of presenting) {
      const p = studyPatient(db, c.id, studyPlace(db, c.id)!, 74_000, 'autumn');
      expect({ id: c.id, primary: p.truth.conditions[0].id }).toEqual({ id: c.id, primary: c.id });
    }
  });
});

describe('приём', () => {
  beforeEach(() => {
    setProfileStore(memoryStore());
    forgetProfile();
  });

  test('инсульт: привезла скорая — давление уже померил фельдшер, лежит под монитором; где лечить — эта больница; тромболизис можно', () => {
    expect(openStudy('cond.stroke_ischemic', 74_001)).toBe(true);
    const v = studyVisit.view();
    expect(studyCondition()).toBe('cond.stroke_ischemic');
    expect(v.done).toEqual(['exam.vitals']);
    expect(v.meanwhile).toEqual([T.study.paramedic, T.study.bay]);
    expect(v.settings.map(s => s.key)).toEqual(['home', 'admit', 'icu', 'surgery', 'ward', 'ambulance']);
    expect(v.treatments.find(t => t.id === 'tx.thrombolysis_stroke')?.disabled).toBeFalsy();
    studyVisit.toggleTreatment('tx.thrombolysis_stroke');
    expect(studyVisit.view().draft.treatments).toContain('tx.thrombolysis_stroke');
  });

  test('в амбулатории КТ нет: кнопка серая с причиной, назначить нельзя; где лечить — домой, в стационар, скорая', () => {
    openStudy('cond.arvi', 74_002);
    const v = studyVisit.view();
    expect(v.unavailable['exam.ct_head']).toBeDefined();
    studyVisit.act('exam.ct_head');
    expect(studyVisit.view().done).not.toContain('exam.ct_head');
    expect(v.settings.map(s => s.key)).toEqual(['home', 'ward', 'ambulance']);
    expect(v.meanwhile).toEqual([]);
  });

  test('аппендицит: «В операционную» — по диагнозу, с названием операции; верный диагноз и операция — без записи в профиль', async () => {
    await loadProfile();
    const before = JSON.stringify(profile());
    openStudy('cond.appendicitis', 74_003);
    expect(studyVisit.view().settings.find(s => s.key === 'surgery')).toMatchObject({ disabled: true, hint: T.shift.ward.noDiagnosis });
    studyVisit.act('exam.ask_complaints');
    studyVisit.chooseDiagnosis('cond.appendicitis');
    const or = studyVisit.view().settings.find(s => s.key === 'surgery')!;
    expect(or.disabled).toBeFalsy();
    expect(or.hint).toBe(db.treatments[db.conditions['cond.appendicitis'].surgery!.tx].name.ru);
    studyVisit.chooseSetting('surgery');
    studyVisit.finish();
    expect(studyVisit.view().decision?.verdict).toBe('correct');
    // ни приёма, ни «встречалось», ни архива, ни рекордов, ни достижений
    expect(JSON.stringify(profile())).toBe(before);
  });

  test('ещё один такой больной — та же болезнь, другой человек', () => {
    openStudy('cond.appendicitis', 74_004);
    const first = studyVisit.seed();
    studyAgain();
    expect(studyCondition()).toBe('cond.appendicitis');
    expect(studyVisit.seed()).not.toBe(first);
    expect(studyVisit.view().decision).toBeUndefined();
  });
});
