// Портреты персонала (FR-AV-4, 0.5.7; spec 2026-10-alarm-portraits): лицо — из зерна имени сотрудника, как у пациентов;
// возраст — из того же зерна и с навыком не меняется; форма — как у его фигурки на карте. Портрет — на экране персонала,
// в карте приёма нанятого врача и в итогах дня.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { Rng } from '../../src/engine/core/rng';
import { FIGURE } from '../../src/engine/hospital/clinic';
import { staffAge } from '../../src/render/look';
import { uniformOfFigure, uniformOfRole } from '../../src/state/clinicMap';
import { memoryStore } from '../../src/state/saves';
import {
  assign, buildAction, buildView, closeDay, endBuild, fire, forgetShift, hire, leaveCase, nextDay, openColleagueCase, setSpeed, setStore,
  shiftCaseView, shiftState, shiftView, staffView, startSandbox, tick,
} from '../../src/state/session';

const THERAPIST = 'role.therapist';

describe('портрет сотрудника', () => {
  test('форма — как у фигурки на карте: должность одета одинаково во всех помещениях; кого нанимают — все на карте', () => {
    for (const [post, figure] of Object.entries(FIGURE)) expect({ post, uniform: uniformOfFigure(figure) }).toEqual({ post, uniform: uniformOfRole(post.split('|')[1]) });
    const hired = Object.keys(db.roles).filter(r => db.roles[r].hire);
    expect(hired.length).toBeGreaterThan(10);
    for (const r of hired) expect({ r, onMap: Object.keys(FIGURE).some(k => k.endsWith(`|${r}`)) }).toEqual({ r, onMap: true });
    expect(['role.nurse', 'role.or_nurse'].map(uniformOfRole)).toEqual(['nurse', 'nurse']);
    expect(['role.registrar', 'role.lab_tech', 'role.radiographer', 'role.radiologist'].map(uniformOfRole)).toEqual(['staff', 'staff', 'staff', 'staff']);
    expect(['role.therapist', 'role.surgeon', 'role.sonographer', 'role.gastroenterologist'].map(uniformOfRole)).toEqual(['doctor', 'doctor', 'doctor', 'doctor']);
  });

  test('возраст — из зерна имени: одно зерно — один возраст; «опытный» — от 40, «новичок» — до 35, остальные — 25–58', () => {
    const seeds = Array.from({ length: 2000 }, (_, i) => Rng.seeded(i + 1).u32());
    const bad = seeds.filter(seed => {
      const e = staffAge(seed, 'experienced'), n = staffAge(seed, 'novice'), c = staffAge(seed, 'careful');
      return staffAge(seed) !== staffAge(seed) || e < 40 || e > 62 || n < 23 || n > 35 || c < 25 || c > 58;
    });
    expect(bad).toEqual([]);
    // лица разного возраста — от молодых до седых
    const ages = seeds.map(seed => staffAge(seed));
    expect(new Set(ages).size).toBe(58 - 25 + 1);
  });
});

describe('портреты на экранах', () => {
  beforeEach(() => {
    setStore(memoryStore());
    forgetShift();
  });

  // минута на карте; автопауза («красный», результаты) — снять
  const minute = () => {
    if (shiftView().paused) setSpeed(1);
    tick(1000);
  };

  test('кандидат и нанятый на одно лицо; врач на приёме и в итогах дня — с портретом, уволенный — без', () => {
    // песочница сессии: продлённый коридор, ординаторская и второй кабинет (как в hired.test)
    startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'doctor', seed: 43, season: 'winter' });
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    expect(buildAction({ kind: 'corridor', cells })).toBeNull();
    expect(buildAction({ kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 })).toBeNull();
    expect(buildAction({ kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 })).toBeNull();
    endBuild();
    const office = buildView()!.plan.rooms[buildView()!.plan.rooms.length - 1].id;
    const staff = staffView()!;
    // у каждого кандидата — портрет в форме его должности
    for (const c of staff.candidates) expect({ role: c.role, uniform: c.portrait.uniform }).toEqual({ role: c.role, uniform: uniformOfRole(c.role) });
    const therapist = staff.candidates.find(c => c.role === THERAPIST)!;
    expect(therapist.portrait.uniform).toBe('doctor');
    hire(therapist.id);
    assign(therapist.id, office);
    const face = therapist.portrait;
    expect(staffView()!.staff.find(m => m.id === therapist.id)!.portrait).toEqual(face);

    nextDay();
    let row: { id: string } | undefined;
    for (let i = 0; i < 400 && !row; i++) {
      minute();
      row = shiftView().colleagues.find(c => shiftState()!.patients[c.id].status === 'inRoom');
    }
    openColleagueCase(row!.id);
    expect(shiftCaseView()!.colleague!.portrait).toEqual(face);
    leaveCase();
    for (let i = 0; i < 180 && !Object.values(shiftState()!.patients).some(p => p.closed?.by === therapist.id); i++) minute();
    closeDay();
    expect(shiftView().summary!.colleagues.find(c => c.id === therapist.id)!.portrait).toEqual(face);
    // смена отработана — навык мог вырасти, лицо то же
    expect(staffView()!.staff.find(m => m.id === therapist.id)!.portrait).toEqual(face);
    fire(therapist.id);
    const gone = shiftView().summary!.colleagues.find(c => c.id === therapist.id)!;
    expect(gone.portrait).toBeUndefined();
  }, 30_000);
});
