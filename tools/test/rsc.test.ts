// Исход перевода по часам до реперфузии, класс Killip, фибрилляция желудочков, сроки тромболизиса и
// перевода (spec 2026-10-chapter-3, часть 39б).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { lossAt, type Outcome, rscOutcome } from '../../src/engine/med/course';
import { generatePatient } from '../../src/engine/med/generate';
import type { Patient } from '../../src/engine/med/types';
import { apply, arrestAfter, current, newCampaign, newSandbox } from '../../src/engine/shift/engine';
import { targetResults, type TargetPlace } from '../../src/engine/shift/targets';
import { DAY, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { outcomeText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const ACS = 'cond.acs';
const LYSIS = 'tx.thrombolysis';
const ONSET = 'hx.onset_hours';
const WAY = db.economy.transfer;
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];

const acs = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: ACS, params });
const paramsOf = (p: Patient) => p.truth.conditions[0].params;
/** Больные с подъёмом ST подряд по зёрнам — с этими значениями параметров. */
function stemis(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  return Array.from({ length: n }, (_, i) => acs(from + i, { type: 'stemi', ...params }));
}
const lysisPlan = { treatments: [LYSIS], setting: 'ambulance' as const };
const noLysis = { treatments: [] as Id[], setting: 'ambulance' as const };
const at = (p: Patient, extra = 20) => p.truth.values[ONSET] * 60 + extra;

describe('исход перевода по часам', () => {
  test('доля потери — ступенями записи: 0 в первый час, 43, 60, 69 до 2, 6 и 12 ч; позже — 100', () => {
    const loss = db.conditions[ACS].reperfusion!.loss;
    expect([0, 59, 60, 119, 120, 359, 360, 719, 720, 2000].map(m => lossAt(loss, m))).toEqual([0, 0, 43, 43, 60, 60, 69, 69, 100, 100]);
  });

  test('тромболизис удаётся у 63 %: удался — артерия через час, не удался — спасающее вмешательство после пути', () => {
    const xs = stemis(3000);
    let ok = 0;
    for (const [i, p] of xs.entries()) {
      const r = rscOutcome(db, p, lysisPlan, at(p), WAY, Rng.seeded(i).fork('rsc'))!.rsc!;
      if (r.by === 'lysis') ok++;
      else expect(r.by).toBe('rescue');
      expect(r.hours).toBe(Math.round((at(p) + (r.by === 'lysis' ? 60 : (WAY.hours + WAY.pci) * 60)) / 60));
    }
    expect(ok / xs.length).toBeGreaterThan(0.6);
    expect(ok / xs.length).toBeLessThan(0.66);
    // без тромболизиса — вмешательство в центре после пути
    const r = rscOutcome(db, xs[0], noLysis, at(xs[0]), WAY, Rng.seeded(1).fork('rsc'))!.rsc!;
    expect(r).toEqual({ by: 'pci', hours: Math.round((at(xs[0]) + 180) / 60), loss: lossAt(db.conditions[ACS].reperfusion!.loss, at(xs[0]) + 180) });
  });

  test('смертность — в границах класса Killip: при шоке выше всего, позже — ближе к верхней границе', () => {
    const died = (killip: string, extra: number) => {
      const xs = stemis(2000, { killip });
      return xs.filter((p, i) => rscOutcome(db, p, noLysis, at(p, extra) - p.truth.values[ONSET] * 60, WAY, Rng.seeded(i).fork('rsc'))!.kind === 'died').length / xs.length;
    };
    // решение в первые минуты от начала: вмешательство через 3 ч — потеря 60 %; через сутки — 100 %
    const early = died('iv', 0);
    const late = died('iv', 24 * 60);
    expect(early).toBeGreaterThan(0.6);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(0.76);
    expect(late).toBeLessThan(0.86);
    expect(died('i', 24 * 60)).toBeLessThan(0.05);
  });

  test('без подъёма ST и у болезни без записи — исход прежний; класс из старых сохранений — первый', () => {
    const nste = acs(7, { type: 'nste' });
    expect(rscOutcome(db, nste, lysisPlan, 120, WAY, Rng.seeded(1))).toBeUndefined();
    const flu = generatePatient(db, 3, { department: 'dept.therapy', season: 'winter', primary: 'cond.influenza' });
    expect(rscOutcome(db, flu, noLysis, 120, WAY, Rng.seeded(1))).toBeUndefined();
    const old = stemis(1)[0];
    delete paramsOf(old).killip;
    expect(rscOutcome(db, old, noLysis, 120, WAY, Rng.seeded(1))!.rsc).toBeDefined();
  });

  test('мягкий режим: вместо смерти в центре — переведён в тяжёлом состоянии', () => {
    const xs = stemis(200, { killip: 'iv' });
    const i = xs.findIndex((p, k) => rscOutcome(db, p, noLysis, at(p), WAY, Rng.seeded(k).fork('rsc'))!.kind === 'died');
    expect(i).toBeGreaterThanOrEqual(0);
    const soft = rscOutcome(db, xs[i], noLysis, at(xs[i]), WAY, Rng.seeded(i).fork('rsc'), true)!;
    expect(soft.kind).toBe('transferred');
    expect(soft.severe).toBe(true);
    expect(soft.rsc).toBeDefined();
  });

  test('строка исхода: как открыли артерию и через сколько часов; позже 12 часов — польза мала; умер — в центре', () => {
    const o = (x: Partial<Outcome>): Outcome => ({ kind: 'transferred', day: 0, cured: false, ...x });
    expect(outcomeText(o({ rsc: { by: 'lysis', hours: 4, loss: 60 } }), 'ambulance', false))
      .toBe('Переведён в сосудистый центр. Тромболизис помог: через 60–90 минут подъём ST снизился наполовину и больше — артерия открыта около 4 ч от начала. Коронарография — в сосудистом центре через 2–24 часа');
    expect(outcomeText(o({ rsc: { by: 'rescue', hours: 6, loss: 69 } }), 'ambulance', true)).toMatch(/^Переведена в сосудистый центр\. Тромболизис не помог: .*спасающее вмешательство, около 6 ч от начала$/);
    expect(outcomeText(o({ rsc: { by: 'pci', hours: 15, loss: 100 } }), 'ambulance', false)).toMatch(/около 15 ч от начала; от начала прошло больше 12 часов — польза для сердца уже мала$/);
    expect(outcomeText(o({ kind: 'died', day: 1, rsc: { by: 'pci', hours: 5, loss: 60 } }), 'ambulance', true)).toMatch(/\. Умерла в сосудистом центре на 2-е сутки$/);
    expect(outcomeText(o({ severe: true, rsc: { by: 'pci', hours: 5, loss: 60 } }), 'ambulance', false)).toMatch(/^Переведён в сосудистый центр в тяжёлом состоянии\. /);
  });
});

describe('класс Killip', () => {
  test('доли по записи; признаки — по классу: шок — низкое давление, отёк лёгких — сатурация', () => {
    const xs = Array.from({ length: 6000 }, (_, i) => acs(i + 1));
    const share = (k: string) => xs.filter(p => paramsOf(p).killip === k).length / xs.length;
    expect(share('i')).toBeGreaterThan(0.75);
    expect(share('i')).toBeLessThan(0.81);
    expect(share('iv')).toBeGreaterThan(0.03);
    expect(share('iv')).toBeLessThan(0.05);
    const has = (k: string, f: Id) => {
      const of = xs.filter(p => paramsOf(p).killip === k);
      return of.filter(p => p.truth.findings.some(x => x.f === f)).length / of.length;
    };
    expect(has('iv', 'vital.bp_low')).toBeGreaterThan(0.9);
    expect(has('i', 'vital.bp_low')).toBe(0);
    expect(has('iii', 'vital.spo2_low')).toBeGreaterThan(0.6);
    expect(has('ii', 'sign.crackles_local')).toBeGreaterThan(0.6);
    // шок гасит высокое давление: одно измерение — одно число
    expect(has('iv', 'vital.bp_high')).toBe(0);
  });
});

/** Районная больница главы 2, открыт первый день. */
function district(seed: number): ShiftState {
  const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.hospital' });
  apply(db, s, { kind: 'nextDay' });
  return s;
}

/**
 * Привезённые скорой, лежащие в смотровой, — с больным инфарктом с подъёмом ST вместо того, кого
 * привезли (часы от начала — `onset`); `pick` выбирает подходящего.
 */
function stemiInBay(pick: (s: ShiftState, p: ShiftPatient) => boolean, onset = 1): { s: ShiftState; p: ShiftPatient } {
  for (let seed = 51; seed < 351; seed++) {
    const s = district(seed);
    for (let i = 0; i < 6 * 60; i++) {
      const p = Object.values(s.patients).find(q => q.kind === 'ambulance' && q.bay && q.status === 'waiting' && !q.sorted && q.scale);
      if (p) {
        const patient = stemis(40, {}, seed * 100).find(x => x.truth.values[ONSET] === onset && x.truth.risks.length === 0) ?? stemis(1, {}, seed * 100)[0];
        p.patient = patient;
        if (pick(s, p)) return { s, p };
        // не подошёл — перевести, чтобы освободил место
        apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
        apply(db, s, { kind: 'call', id: p.id });
        if (current(s)?.id === p.id) close(s, p, 'ambulance');
        continue;
      }
      apply(db, s, { kind: 'advance', seconds: 60 });
    }
  }
  throw new Error('за 300 зёрен не нашлось');
}

function close(s: ShiftState, p: ShiftPatient, setting: 'ambulance' | 'admit' | 'icu', treatments: Id[] = []) {
  for (const tx of treatments) apply(db, s, { kind: 'toggleTreatment', id: tx });
  apply(db, s, { kind: 'diagnose', id: p.patient.truth.conditions[0].id });
  apply(db, s, { kind: 'setting', setting });
  apply(db, s, { kind: 'finish' });
}

describe('смена', () => {
  test('переведённый из больницы с приёмным — исход по часам до реперфузии', () => {
    const { s, p } = stemiInBay(() => true);
    apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
    apply(db, s, { kind: 'call', id: p.id });
    close(s, p, 'ambulance', [LYSIS, 'tx.aspirin_acs', 'tx.clopidogrel', 'tx.enoxaparin_acs']);
    const rsc = s.patients[p.id].closed!.outcome.rsc!;
    expect(['lysis', 'rescue']).toContain(rsc.by);
    expect(rsc.hours).toBeGreaterThanOrEqual(p.patient.truth.values[ONSET]);
  });

  test('фибрилляция: момент из ветви зерна, в окне 12 часов от начала; позже окна и без подъёма ST — нет', () => {
    const s = district(61);
    const fake = (id: string, patient: Patient) => ({ id, patient }) as ShiftPatient;
    const p = stemis(200).find(x => x.truth.values[ONSET] === 1)!;
    const vfs = Array.from({ length: 400 }, (_, i) => arrestAfter(db, s, fake(`x${i}`, p)));
    // одно и то же — тот же ответ
    expect(arrestAfter(db, s, fake('x7', p))).toBe(vfs[7]);
    // окно 11 часов при 1 % в час: около 10 %
    const inWindow = vfs.filter(v => v !== undefined);
    expect(inWindow.length / vfs.length).toBeGreaterThan(0.06);
    expect(inWindow.length / vfs.length).toBeLessThan(0.15);
    for (const v of inWindow) expect(v!).toBeLessThan(11 * 3600);
    const late = stemis(400).find(x => x.truth.values[ONSET] >= 12)!;
    expect(Array.from({ length: 200 }, (_, i) => arrestAfter(db, s, fake(`x${i}`, late))).every(v => v === undefined)).toBe(true);
    const nste = acs(5, { type: 'nste' });
    expect(Array.from({ length: 200 }, (_, i) => arrestAfter(db, s, fake(`x${i}`, nste))).every(v => v === undefined)).toBe(true);
  });

  test('в смотровой фибрилляцию снимают разрядом: уведомление и отметка в закрытом приёме', () => {
    const { s, p } = stemiInBay(() => true);
    s.events.unshift({ t: s.t + 60, seq: s.seq++, event: { kind: 'arrest', id: p.id } });
    const notices = apply(db, s, { kind: 'advance', seconds: 120 });
    expect(notices).toContainEqual({ kind: 'arrest', id: p.id });
    expect(s.patients[p.id].arrest).toBeDefined();
    apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
    apply(db, s, { kind: 'call', id: p.id });
    close(s, p, 'ambulance');
    expect(s.patients[p.id].closed!.arrest).toBe(true);
  });

  /** Фибрилляция позже, чем через полчаса, — уже в палате или ПИТ. */
  const vfLater = (s: ShiftState, p: ShiftPatient) => {
    const vf = arrestAfter(db, s, p);
    return vf !== undefined && p.arriveT + vf > s.t + 30 * 60;
  };

  test('в палате без монитора фибрилляция — смерть в ночь этих суток', () => {
    const { s, p } = stemiInBay(vfLater);
    apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
    apply(db, s, { kind: 'call', id: p.id });
    const vf = arrestAfter(db, s, p)!;
    close(s, p, 'admit');
    const stay = s.patients[p.id].stay!;
    expect(stay.dies).toBe(Math.floor((p.arriveT + vf) / DAY) + 1 - stay.since);
    expect(stay.shock).toBeUndefined();
  });

  test('в ПИТ фибрилляцию снимают разрядом — строка обхода, а не смерть', () => {
    // ПИТ есть только в своей больнице (песочница): готовая амбулатория и ПИТ на две койки, как в icu.test.ts
    for (let seed = 21; seed < 121; seed++) {
      const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
      const cells: [number, number][] = [];
      for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
      apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
      apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.icu', size: 'S', x: 29, y: 0, rot: 0 } });
      const icu = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
      for (let i = 0; i < 2; i++) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: icu, equipment: 'eq.monitor_defib' } });
      apply(db, s, { kind: 'buildEnd' });
      apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: icu });
      const c = s.candidates!.find(x => x.role === 'role.anesthetist')!;
      apply(db, s, { kind: 'hire', id: c.id });
      apply(db, s, { kind: 'assign', id: c.id, room: icu });
      apply(db, s, { kind: 'nextDay' });
      for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
      const p = s.queue[0] ? s.patients[s.queue[0]] : undefined;
      if (!p) continue;
      p.patient = stemis(40, {}, seed * 100).find(x => x.truth.values[ONSET] === 1)!;
      if (!vfLater(s, p)) continue;
      const vf = arrestAfter(db, s, p)!;
      apply(db, s, { kind: 'call', id: p.id });
      close(s, p, 'icu');
      const stay = s.patients[p.id].stay!;
      expect(stay.shock).toBe(Math.floor((p.arriveT + vf) / DAY) + 1 - stay.since);
      expect(stay.dies).toBeUndefined();
      return;
    }
    throw new Error('за 100 зёрен не нашлось');
  });
});

describe('сроки тромболизиса и перевода', () => {
  const place: TargetPlace = { roomType: () => 'room.emergency', bedside: () => true, can: () => true };
  const st = { exam: 'exam.ecg', obs: [{ f: 'ecg.st_elevation', shown: true, exam: 'exam.ecg' }], at: 600 + 5 * 60, step: 1 };
  const p = { patient: acs(3, { type: 'stemi' }), bay: { room: 'r1', bed: 0 }, arriveT: 600, results: [st] };
  const ids = (xs: ReturnType<typeof targetResults>) => xs.map(x => [x.id, x.minutes, x.grade]);

  test('тромболизис — от ЭКГ с подъёмом ST, перевод — от прихода; решение — в минуту закрытия', () => {
    const r = targetResults(db, p, place, { t: 600 + 18 * 60, plan: { treatments: [LYSIS], setting: 'ambulance' } });
    expect(ids(r).filter(x => x[0] !== 'target.ecg_chest_pain')).toEqual([['target.lysis_stemi', 13, 'B'], ['target.transfer_stemi', 18, 'A']]);
  });

  test('не назначили тромболизис — срока на него нет; не перевели — срока на перевод нет; без подъёма ST — ни того ни другого', () => {
    const r = targetResults(db, p, place, { t: 600 + 18 * 60, plan: { treatments: [], setting: 'admit' } });
    expect(r.map(x => x.id)).not.toContain('target.lysis_stemi');
    expect(r.map(x => x.id)).not.toContain('target.transfer_stemi');
    const none = targetResults(db, { ...p, results: [{ ...st, obs: [{ ...st.obs[0], shown: false }] }] }, place, { t: 600 + 18 * 60, plan: lysisPlan });
    expect(none.map(x => x.id)).toEqual(p.patient.complaints.includes('sym.chest_pain_pressing') ? ['target.ecg_chest_pain'] : []);
  });

  test('сидящему в кабинете — сроков смотровой нет', () => {
    const r = targetResults(db, { ...p, bay: undefined }, place, { t: 600 + 18 * 60, plan: lysisPlan });
    expect(r).toEqual([]);
  });
});

describe('энциклопедия', () => {
  test('у ОКС — «После перевода»: путь, тромболизис, смертность по классу Killip, фибрилляция; признаки — с классом', () => {
    const a = article(db, ACS)!;
    const after = a.blocks.find(b => b.key === 'afterTransfer')!;
    expect(after.text).toEqual([
      'Артерию открывают тромболизисом здесь или вмешательством в сосудистом центре: до него 2 ч пути, там до вмешательства — 1 ч.',
      'Тромболизис открывает артерию у 63 % больных: через 60–90 минут подъём ST снижается наполовину и больше. Нет — в центре спасающее вмешательство.',
      'Смертность в стационаре — по классу Killip: I — 2–3 %, II — 5–12 %, III — 10–20 %, IV — 50–81 %. Чем позже открыли артерию, тем ближе к верхней границе; позже 12 часов польза для сердца мала.',
      'До открытия артерии, в первые 12 часов от начала, — фибрилляция желудочков: около 1 % в час. Под монитором её снимают разрядом, без монитора она смертельна.',
    ]);
    expect(after.refs!.map(r => r.id)).toEqual([LYSIS]);
    const signs = a.blocks.find(b => b.key === 'signs')!.rows!.flatMap(r => r.refs);
    expect(signs.find(r => r.id === 'vital.bp_low')!.note).toBe('при кардиогенном шоке (Killip IV)');
  });
});
