// Реанимация (spec 2026-10-chapter-4, часть 47): у каждой койки монитор и аппарат ИВЛ, анестезиолог-реаниматолог и
// медсестра; место `ricu` — «В ОРИТ»: закрывает и ПИТ, а ПИТ тому, кому нужна ИВЛ, — меньше нужного; нет своей
// реанимации — перевод. ИВЛ и наркоз в вену — лечение реанимации: назначил — место «В ОРИТ», выбрал другое —
// снимается. Рефрактерный эпилептический статус (741_1; Novy 2010) — наркоз в вену с ИВЛ; норэпинефрин — при
// кардиогенном шоке (156_2, 157_5).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { wardIncome } from '../../src/engine/economy/economy';
import { generatePatient } from '../../src/engine/med/generate';
import { choiceFor, evaluatePlan, recommendedSetting, settingFit, txAvailable } from '../../src/engine/med/plan';
import { choosePlan } from '../../src/engine/med/policy';
import {
  apply, careUnit, freeRicuBeds, hospitalCtx, icuBeds, inIcu, inRicu, newSandbox, ricuBeds, wardBeds,
} from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { article } from '../../src/state/encyclopedia';

const SE = 'cond.status_epilepticus';
const VENT = 'tx.ventilation';
const NARCOSIS = 'tx.anesthetic_iv';

/**
 * Песочница с готовой амбулаторией и реанимацией на четыре койки справа: мониторов и аппаратов ИВЛ — сколько
 * сказано; медсестра ЭКГ — в реанимацию, анестезиолог-реаниматолог — из кандидатов.
 */
function withRicu(monitors: number, vents: number, seed = 21): { s: ShiftState; ricu: string } {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ricu', size: 'M', x: 29, y: 0, rot: 0 } });
  const ricu = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  // аппараты ИВЛ дороги: к готовой амбулатории — денег на всю реанимацию
  s.economy!.cash += 1_000_000;
  for (let i = 0; i < vents; i++) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: ricu, equipment: 'eq.ventilator' } });
  for (let i = 0; i < monitors; i++) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: ricu, equipment: 'eq.monitor_defib' } });
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: ricu });
  const c = s.candidates!.find(x => x.role === 'role.anesthetist')!;
  apply(db, s, { kind: 'hire', id: c.id });
  apply(db, s, { kind: 'assign', id: c.id, room: ricu });
  return { s, ricu };
}

/** Первый в очереди — с эпилептическим статусом (`refractory` — рефрактерный), вызван; принят и с неврологией. */
function status(s: ShiftState, refractory: 'yes' | 'no'): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const id = s.queue[0];
  const p = s.patients[id];
  p.patient = generatePatient(db, 4747, { department: 'dept.neurology', season: 'winter', primary: SE, params: { refractory } });
  p.departments = ['dept.therapy', 'dept.neurology'];
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.ask_seizure' });
  apply(db, s, { kind: 'diagnose', id: SE });
  return p;
}

describe('реанимация: где лечить', () => {
  test('ОРИТ закрывает палату, срочный стационар, ПИТ и себя; ПИТ вместо ОРИТ — меньше нужного; скорая и перевод — ОРИТ где-то ещё', () => {
    expect(['ward', 'ambulance', 'icu', 'ricu'].map(need => settingFit(need as 'ward', 'ricu'))).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(settingFit('ricu', 'icu')).toBe('under');
    expect(settingFit('ricu', 'admit')).toBe('under');
    expect([settingFit('ricu', 'ambulance'), settingFit('ricu', 'transfer')]).toEqual(['ok', 'ok']);
    // операцию и центр своя реанимация не заменяет; лишняя для того, кого лечат дома
    expect([settingFit('surgery', 'ricu'), settingFit('transfer', 'ricu'), settingFit('home', 'ricu')]).toEqual(['under', 'under', 'over']);
    // своя реанимация — в неё; нет её — скорая («Перевести»); ПИТ нет, а реанимация есть — нужному ПИТ туда
    expect([choiceFor('ricu', { ricu: true }), choiceFor('ricu', { icu: true, ward: true }), choiceFor('ricu')]).toEqual(['ricu', 'ambulance', 'ambulance']);
    expect([choiceFor('icu', { ricu: true }), choiceFor('icu', { icu: true, ricu: true })]).toEqual(['ricu', 'icu']);
  });

  test('рефрактерный эпилептический статус — в реанимацию, нерефрактерный — в ПИТ; противосудорожные скорой не помогли — видно из расспроса', () => {
    const yes = generatePatient(db, 4747, { department: 'dept.neurology', season: 'winter', primary: SE, params: { refractory: 'yes' } });
    const no = generatePatient(db, 4747, { department: 'dept.neurology', season: 'winter', primary: SE, params: { refractory: 'no' } });
    expect([recommendedSetting(db, yes), recommendedSetting(db, no)]).toEqual(['ricu', 'icu']);
    expect(db.conditions[SE].params?.refractory).toEqual({ no: 77, yes: 23 });
    expect(db.exams['exam.ask_seizure'].checks.some(c => c.f === 'hx.aed_failed')).toBe(true);
  });

  test('разумный врач: рефрактерный в больнице с реанимацией — наркоз, ИВЛ и «В ОРИТ»; без неё — бензодиазепин и перевод', () => {
    const yes = generatePatient(db, 4747, { department: 'dept.neurology', season: 'winter', primary: SE, params: { refractory: 'yes' } });
    const obs = [{ exam: 'exam.ask_seizure', f: 'hx.aed_failed', shown: true }, { exam: 'exam.ask_seizure', f: 'sym.seizure_ongoing', shown: true }];
    const here = choosePlan(db, SE, obs, yes, { ward: true, icu: true, ricu: true, bedside: ['eq.monitor_defib'] });
    expect(here.setting).toBe('ricu');
    expect(here.treatments).toEqual(expect.arrayContaining([NARCOSIS, VENT, 'tx.benzodiazepine']));
    const away = choosePlan(db, SE, obs, yes, { ward: true, icu: true, bedside: ['eq.monitor_defib'] });
    expect(away.setting).toBe('ambulance');
    expect(away.treatments).toContain('tx.benzodiazepine');
    expect(away.treatments.some(tx => tx === NARCOSIS || tx === VENT)).toBe(false);
    // в реанимации всё нужное есть; при переводе ИВЛ не в вину — её здесь не сделать
    expect(evaluatePlan(db, yes, here, obs, { ricu: true }).requireMissing).toEqual([]);
    expect(evaluatePlan(db, yes, away, obs, { icu: true }).requireMissing).toEqual([]);
  });
});

describe('реанимация: помещение и койки', () => {
  test('у койки — монитор и аппарат ИВЛ на своих местах; работает койка, где есть оба; реанимация — не ПИТ и не палата', () => {
    const none = withRicu(4, 0);
    expect(ricuBeds(db, none.s)).toEqual([]);
    const two = withRicu(4, 2);
    expect(ricuBeds(db, two.s)).toEqual([{ room: two.ricu, bed: 0 }, { room: two.ricu, bed: 1 }]);
    // аппараты встают на свои места: мониторы — первые четыре, аппараты ИВЛ — следующие
    const room = hospitalCtx(db, two.s).plan.rooms.find(r => r.id === two.ricu)!;
    expect(room.equipment).toEqual(['eq.monitor_defib', 'eq.monitor_defib', 'eq.monitor_defib', 'eq.monitor_defib', 'eq.ventilator', 'eq.ventilator', null, null]);
    expect([icuBeds(db, two.s), wardBeds(db, two.s)]).toEqual([[], []]);
    // аппараты ИВЛ без мониторов — койка тоже не работает
    expect(ricuBeds(db, withRicu(0, 4).s)).toEqual([]);
  });

  test('аппарат ИВЛ — только в реанимацию; ИВЛ и наркоз в вену — только с ним, у постели реанимации', () => {
    expect(db.equipment['eq.ventilator'].rooms).toEqual(['room.ricu']);
    expect(db.rooms['room.ricu']).toMatchObject({ icu: true, vent: true, equipment: ['eq.monitor_defib', 'eq.ventilator'] });
    expect(db.rooms['room.ricu'].sizes.map(z => [z.id, z.beds, z.slots.length])).toEqual([['M', 4, 8], ['L', 6, 12]]);
    expect([db.treatments[VENT].place, db.treatments[NARCOSIS].place]).toEqual(['ricu', 'ricu']);
    expect(db.treatments[NARCOSIS].companions).toEqual([VENT]);
    // в кабинете и в смотровой его нет; есть свободная койка реанимации — сделают там; на обходе — у её койки
    expect([txAvailable(db, VENT), txAvailable(db, VENT, { bedside: ['eq.monitor_defib'] }), txAvailable(db, VENT, { ricu: true }), txAvailable(db, VENT, { bedside: ['eq.monitor_defib', 'eq.ventilator'] })])
      .toEqual([false, false, true, true]);
  });
});

describe('реанимация: решение, поступление, касса', () => {
  test('ИВЛ назначил — место «В ОРИТ»; выбрал другое — ИВЛ снимается; рефрактерный в ОРИТ — место A, лежит на койке с ИВЛ', () => {
    const { s, ricu } = withRicu(4, 4);
    apply(db, s, { kind: 'nextDay' });
    const p = status(s, 'yes');
    apply(db, s, { kind: 'toggleTreatment', id: VENT });
    expect(p.draft).toMatchObject({ setting: 'ricu', treatments: [VENT] });
    apply(db, s, { kind: 'setting', setting: 'ambulance' });
    expect(p.draft).toMatchObject({ setting: 'ambulance', treatments: [] });
    for (const tx of ['tx.benzodiazepine', NARCOSIS, VENT]) apply(db, s, { kind: 'toggleTreatment', id: tx });
    expect(p.draft.setting).toBe('ricu');
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.grades.setting).toBe('A');
    expect(p.closed!.notes.filter(n => n.code.startsWith('tx.require') || n.code.startsWith('setting.'))).toEqual([]);
    expect(p.status).toBe('admitted');
    expect(p.stay!.room).toBe(ricu);
    expect([inRicu(db, s, p), inIcu(db, s, p)]).toEqual([true, true]);
    expect(freeRicuBeds(db, s)).toHaveLength(3);
    expect(s.summary.ward).toMatchObject({ admitted: 1, ricu: 1 });
    apply(db, s, { kind: 'closeDay' });
    expect(s.summary.ward).toMatchObject({ lying: 1, ricuLying: 1 });
    expect(s.summary.ward?.icuLying).toBeUndefined();
    // ночь в реанимации — дороже ПИТ
    expect(s.summary.economy!.ledger.expenses.ward).toBe(db.economy.ricu.bedDay);
  });

  test('без реанимации ИВЛ не назначить, «В ОРИТ» не выбрать; рефрактерный в ПИТ — меньше нужного', () => {
    const { s } = withRicu(4, 0);
    apply(db, s, { kind: 'nextDay' });
    const p = status(s, 'yes');
    apply(db, s, { kind: 'toggleTreatment', id: VENT });
    apply(db, s, { kind: 'setting', setting: 'ricu' });
    expect(p.draft.treatments).toEqual([]);
    expect(p.draft.setting).not.toBe('ricu');
    expect(settingFit(recommendedSetting(db, p.patient), 'icu')).toBe('under');
  });

  test('заняли последнюю койку реанимации, пока решали, — перевод, и ИВЛ снимается', () => {
    const { s } = withRicu(4, 1);
    apply(db, s, { kind: 'nextDay' });
    const first = status(s, 'yes');
    for (const tx of ['tx.benzodiazepine', NARCOSIS, VENT]) apply(db, s, { kind: 'toggleTreatment', id: tx });
    apply(db, s, { kind: 'finish' });
    expect(inRicu(db, s, first)).toBe(true);
    const second = status(s, 'yes');
    second.draft = { ...second.draft, treatments: [VENT], setting: 'ricu' };
    apply(db, s, { kind: 'finish' });
    expect(second.closed!.plan).toMatchObject({ setting: 'ambulance', treatments: [] });
  });

  test('прибавка за реанимацию — только если она была нужна; нужна была ПИТ — прибавка за ПИТ', () => {
    const t = db.economy.tariffs;
    const full = wardIncome(db, SE, 'A', 'full');
    expect(wardIncome(db, SE, 'A', 'full', undefined, 'ricu')).toBe(full + t.omsRicu);
    expect(t.omsRicu).toBeGreaterThan(t.omsIcu);
    expect(db.economy.ricu.bedDay).toBeGreaterThan(db.economy.icu.bedDay);
    expect([careUnit('ricu', 'ricu'), careUnit('ricu', 'icu'), careUnit('icu', 'icu'), careUnit('ricu', 'ward'), careUnit('admit', 'ricu')]).toEqual(['ricu', 'icu', 'icu', undefined, undefined]);
  });

  test('те же команды — тот же итог: реанимация, ИВЛ и поступление детерминированы', () => {
    const run = () => {
      const { s } = withRicu(4, 4, 33);
      apply(db, s, { kind: 'nextDay' });
      status(s, 'yes');
      for (const tx of ['tx.benzodiazepine', NARCOSIS, VENT]) apply(db, s, { kind: 'toggleTreatment', id: tx });
      apply(db, s, { kind: 'finish' });
      apply(db, s, { kind: 'closeDay' });
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });
});

describe('норэпинефрин', () => {
  test('холодная ОДСН: допамин или норэпинефрин — из группы хватит одного; при кардиогенном шоке у инфаркта — допустимо', () => {
    const p = generatePatient(db, 515, { department: 'dept.therapy', season: 'winter', primary: 'cond.adhf', params: { type: 'cold' } });
    const venue = { bedside: ['eq.monitor_defib'], icu: true };
    const ev = evaluatePlan(db, p, { treatments: ['tx.lmwh', 'tx.norepinephrine'], setting: 'icu' }, [], venue);
    expect(ev.requireMissing).toEqual([]);
    expect(ev.roles.find(r => r.tx === 'tx.norepinephrine')?.role).toBe('require');
    expect(db.treatments['tx.norepinephrine'].bedside).toEqual({ equipment: ['eq.monitor_defib'] });
    const mi = generatePatient(db, 515, { department: 'dept.therapy', season: 'winter', primary: 'cond.acs', params: { killip: 'iv' } });
    const role = evaluatePlan(db, mi, { treatments: ['tx.aspirin_acs', 'tx.norepinephrine'], setting: 'ambulance' }, [], venue).roles.find(r => r.tx === 'tx.norepinephrine')?.role;
    expect(role).toBe('acceptable');
  });
});

describe('реанимация: энциклопедия', () => {
  test('у реанимации — оба аппарата у каждой койки; ИВЛ — только в реанимации; статус — где лечить рефрактерный', () => {
    const room = article(db, 'room.ricu')!.blocks.find(b => b.key === 'needs')!.rows!;
    expect(room.map(r => [r.label, r.refs.map(x => x.id)])).toEqual([
      ['Люди', ['role.nurse', 'role.anesthetist']], ['У каждой койки — все эти аппараты', ['eq.monitor_defib', 'eq.ventilator']],
    ]);
    const where = article(db, VENT)!.blocks.find(b => b.key === 'where')!;
    expect(where.text).toEqual(['Только в реанимации: назначили — место становится «В ОРИТ»; своей реанимации нет — больного переводят']);
    expect(where.refs!.map(r => r.id)).toEqual(['eq.ventilator', 'room.ricu']);
    // аппаратом ИВЛ делают лечение у постели — ИВЛ и наркоз
    expect(article(db, 'eq.ventilator')!.blocks.find(b => b.key === 'examsBy')!.refs!.map(r => r.id)).toEqual([VENT, NARCOSIS]);
  });
});

