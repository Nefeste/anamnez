// «Код синий» (spec 2026-10-code-blue, вопрос 52, вариант 1): фибрилляция желудочков у лежащего в смотровой приёмного —
// на экране «Код синий: остановка сердца», сигнал монитора, как с 0.5.7; на карте медсестра смотровой и
// анестезиолог-реаниматолог палаты интенсивной терапии бегут к койке и `CODE` секунд у неё, потом — на свои места.
// Медсестра смотровой с части 89 на карте и без тревоги — у своего места. Сам разряд и ритм — в движке (rsc.test).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { type ClinicLayout, layoutOf } from '../../src/engine/hospital/clinic';
import { apply, hospitalCtx, newCampaign } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { CODE, placements } from '../../src/state/clinicMap';

/** Глава 3: в смотровой приёмного лежит привезённый скорой; в больнице есть палата интенсивной терапии. */
function withBay(): { s: ShiftState; map: ClinicLayout; p: ShiftPatient } {
  for (let seed = 1; seed < 41; seed++) {
    const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.vascular' });
    apply(db, s, { kind: 'nextDay' });
    const ctx = hospitalCtx(db, s);
    const map = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
    for (let i = 0; i < 8 * 60 && s.dayOpen; i++) {
      const p = Object.values(s.patients).find(q => q.kind === 'ambulance' && q.bay && q.status === 'waiting' && !q.closed && q.arrest === undefined);
      if (p) return { s, map, p };
      apply(db, s, { kind: 'advance', seconds: 60 });
    }
  }
  throw new Error('за 40 зёрен не нашлось');
}

const roomOf = (map: ClinicLayout, [x, y]: [number, number]) => map.rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)?.id;

describe('«код синий»', () => {
  test('медсестра смотровой приёмного — на карте, у своего места в смотровой', () => {
    const { s, map, p } = withBay();
    const nurse = placements(db, map, s).find(x => x.doing.kind === 'staff' && x.doing.role === 'erNurse');
    expect(nurse).toBeDefined();
    expect(roomOf(map, (nurse!.where as { cell: [number, number] }).cell)).toBe(p.bay!.room);
  });

  test('остановка сердца: медсестра смотровой и анестезиолог-реаниматолог — у койки, пока идёт код; потом — на местах', () => {
    const { s, map, p } = withBay();
    const posts = new Map(placements(db, map, s).filter(x => x.id.startsWith('staff.')).map(x => [x.id, x.where]));
    s.events.unshift({ t: s.t + 1, seq: s.seq++, event: { kind: 'arrest', id: p.id } });
    const heard = apply(db, s, { kind: 'advance', seconds: 1 });
    expect(heard).toContainEqual({ kind: 'arrest', id: p.id });
    const bed = map.beds[p.bay!.room][p.bay!.bed];
    const team = placements(db, map, s).filter(x => x.doing.kind === 'code');
    expect(team.map(x => (x.doing as { role: string }).role).sort()).toEqual(['erNurse', 'icuDoctor']);
    for (const x of team) {
      const [cx, cy] = (x.where as { cell: [number, number] }).cell;
      expect(Math.max(Math.abs(cx - bed[0]), Math.abs(cy - bed[1]))).toBe(1);
    }
    // двое — на разных клетках
    expect(new Set(team.map(x => JSON.stringify(x.where))).size).toBe(2);
    apply(db, s, { kind: 'advance', seconds: CODE });
    const after = placements(db, map, s);
    expect(after.some(x => x.doing.kind === 'code')).toBe(false);
    for (const x of team) expect(after.find(y => y.id === x.id)!.where).toEqual(posts.get(x.id)!);
  });

  test('остановка кровообращения без первой меры (часть 95, `code`): та же бригада у койки, пока идёт код', () => {
    const { s, map, p } = withBay();
    p.code = s.t;
    const team = placements(db, map, s).filter(x => x.doing.kind === 'code');
    expect(team.map(x => (x.doing as { role: string }).role).sort()).toEqual(['erNurse', 'icuDoctor']);
    apply(db, s, { kind: 'advance', seconds: CODE });
    expect(placements(db, map, s).some(x => x.doing.kind === 'code')).toBe(false);
  });

  test('на экране — «Код синий: остановка сердца», смотровая приёмного, и что ритм восстановлен', () => {
    const line = T.shift.notice.arrest('Иванов Пётр');
    expect(line.startsWith('Код синий: остановка сердца')).toBe(true);
    expect(line).toContain('смотровая приёмного');
    expect(line).toContain('ритм восстановлен');
  });
});
