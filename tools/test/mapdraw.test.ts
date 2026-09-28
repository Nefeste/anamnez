// Рисунок плана (spec 2026-09-living-map, части 22–23): фигурки как на портрете, подписи
// помещаются, люди смотрят по ходу и на стол; и сам рисунок без экрана (Skia через CanvasKit,
// tools/imaging/headless.ts) — стена полосой с полом по обе стороны, дверь — проём, у каждого
// предмета и аппарата свой рисунок, у аппарата — и рисунок «работает».
import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { clinicLayout } from '../../src/engine/hospital/clinic';
import { CELL } from '../../src/engine/hospital/grid';
import { T } from '../../src/i18n';
import { CLOTHES, lookOf, SKIN } from '../../src/render/look';
import { BODIES, bodyIndex, HAIRS, headIndex, HEADS, patientFigure, STYLES, staffFigure } from '../../src/render/map/figures';
import { badgeAt, doorOnTop, GLYPH, longestLine, MIN_FONT, roomLabel } from '../../src/render/map/labels';
import { CELL_PX, WALL_IN, WALL_OUT } from '../../src/render/map/metrics';
import { headingOf } from '../../src/render/map/orient';
import { SPEED, Walkers } from '../../src/render/map/walkers';
import type { Placement } from '../../src/state/clinicMap';
import { loadSkia, rasterize } from '../imaging/headless';

const layout = clinicLayout(db);
const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));

describe('план: фигурки', () => {
  test('номера тел и голов — в атласе и не повторяются', () => {
    const bodies = new Set<number>([bodyIndex({ uniform: 'doctor' }), bodyIndex({ uniform: 'nurse' }), bodyIndex({ uniform: 'staff' })]);
    for (let c = 0; c < CLOTHES.length; c++) for (const u of [0, 1, 2] as const) bodies.add(bodyIndex({ clothes: c, urgency: u }));
    expect(bodies.size).toBe(BODIES);
    expect(Math.max(...bodies)).toBe(BODIES - 1);
    const heads = new Set<number>();
    for (let s = 0; s < SKIN.length; s++) {
      for (let h = 0; h < HAIRS.length; h++) for (const st of STYLES) heads.add(headIndex(s, h, st));
      heads.add(headIndex(s, 0, 'cap'));
    }
    expect(heads.size).toBe(HEADS);
    expect(Math.max(...heads)).toBe(HEADS - 1);
  });

  test('пациент на карте — с одеждой, волосами и причёской портрета; обод — по срочности', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const look = lookOf(seed, seed % 2 ? 'm' : 'f', 20 + seed);
      const f = patientFigure(look, (seed % 3) as 0 | 1 | 2);
      const style = look.bald ? 'bald' : look.long ? 'long' : 'short';
      expect(f.body).toBe(bodyIndex({ clothes: CLOTHES.indexOf(look.clothes), urgency: (seed % 3) as 0 | 1 | 2 }));
      expect(f.head).toBe(headIndex(SKIN.indexOf(look.skin), HAIRS.indexOf(look.hair), style));
    }
  });

  test('персонал: форма по должности, лицо всегда то же, у медсестры — шапочка', () => {
    expect(staffFigure('doctor', 'staff.doctor')).toEqual(staffFigure('doctor', 'staff.doctor'));
    expect(staffFigure('doctor', 'staff.doctor').body).toBe(bodyIndex({ uniform: 'doctor' }));
    const nurse = staffFigure('nurse', 'staff.nurse');
    expect(nurse.body).toBe(bodyIndex({ uniform: 'nurse' }));
    expect(nurse.head).toBeGreaterThanOrEqual(SKIN.length * HAIRS.length * STYLES.length);
    // разные места — разные лица хотя бы иногда
    const faces = new Set(Array.from({ length: 12 }, (_, i) => staffFigure('staff', `staff.x${i}`).head));
    expect(faces.size).toBeGreaterThan(4);
  });
});

describe('план: подписи помещений', () => {
  test('длинное название из двух слов на экране стройки — в две строки, крупнее, чем в одну', () => {
    // экран стройки: подпись в клетках плана (16 точек), «Доврачебный кабинет» в помещении 6 клеток
    const one = roomLabel('Ординаторская', { x: 0, y: 0, w: 6 }, 16);
    expect(one.lines).toBe(1);
    const two = roomLabel('Доврачебный кабинет', { x: 0, y: 0, w: 6 }, 16);
    expect(two.lines).toBe(2);
    // в две строки кегль крупнее, чем влез бы в одну
    expect(two.fontSize).toBeGreaterThan(two.width / ('Доврачебный кабинет'.length * GLYPH));
    expect(longestLine('Доврачебный кабинет')).toBe('Доврачебный'.length);
    // подпись внизу поднята на две строки
    const low = roomLabel('Доврачебный кабинет', { x: 0, y: 0, w: 6, h: 7 }, 16, true);
    const low1 = roomLabel('Санузел', { x: 0, y: 0, w: 6, h: 7 }, 16, true);
    expect(low.top).toBeLessThan(low1.top);
  });

  test('каждая подпись влезает в своё помещение на телефоне шириной 360 точек, от стены до стены', () => {
    const cell = 360 / layout.grid.w;
    let checked = 0;
    for (const room of Object.values(db.rooms)) {
      const type = room.id.slice('room.'.length);
      const names = [T.shift.map.rooms[type], ...(type === 'office' ? [T.shift.map.rooms.colleagueOffice] : [])];
      for (const name of names) {
        expect({ type, name: !!name }).toEqual({ type, name: true });
        for (const size of room.sizes) {
          // поворот на четверть — ширина становится высотой
          for (const w of [size.w, size.h]) {
            const at = roomLabel(name, { x: 0, y: 0, w }, cell);
            expect({ name, w, fits: at.fontSize > MIN_FONT }).toEqual({ name, w, fits: true });
            // самая длинная строка — во всю строку или половина названия в две строки
            const line = at.lines === 2 ? longestLine(name) : name.length;
            expect(line * GLYPH * at.fontSize).toBeLessThanOrEqual(at.width + 1e-9);
            // слева — за внутренней гранью стены
            expect(at.left).toBeGreaterThan((0.5 + WALL_IN / 2) * cell);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('план: значки помещений', () => {
  test('значок — внутри помещения, в углу дальше от двери: не на створке и не на подписи', () => {
    type Box = [number, number, number, number];
    const cross = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const inner = 0.5 + WALL_IN / 2;
    let checked = 0;
    for (const room of Object.values(db.rooms)) {
      const type = room.id.slice('room.'.length);
      // значок бывает у помещений с должностью (нет персонала) и у кабинета, ЭКГ, рентгена (очередь)
      if (Object.keys(room.sizes[0].staff).length === 0) continue;
      const name = T.shift.map.rooms[type]!;
      for (const size of room.sizes) {
        for (const [w, h] of [[size.w, size.h], [size.h, size.w]]) {
          const r = { x: 0, y: 0, w, h };
          // дверь — в любой стене, не у угла (в шаблонах — от второй клетки от угла)
          const doors: [number, number][] = [];
          for (let i = 2; i <= w - 3; i++) doors.push([i, 0], [i, h - 1]);
          for (let i = 2; i <= h - 3; i++) doors.push([0, i], [w - 1, i]);
          for (const cell of [12, 16, 24]) {
            for (const door of doors) {
              const top = doorOnTop(r, [door]);
              const at = badgeAt(r, cell, top, door);
              // очередь из двух цифр: поля, фигурка, промежуток, цифры, рамка
              const bw = at.size * (0.44 + 0.84 * 0.66 + 2 * 0.62 * 0.6) + 4;
              const badge: Box = at.side === 'left' ? [at.x, at.top, at.x + bw, at.top + at.size] : [at.x - bw, at.top, at.x, at.top + at.size];
              expect(badge[0]).toBeGreaterThanOrEqual(inner * cell);
              expect(badge[2]).toBeLessThanOrEqual((w - inner) * cell);
              expect(badge[1]).toBeGreaterThanOrEqual(inner * cell);
              expect(badge[3]).toBeLessThanOrEqual((h - inner) * cell);
              // створка с дугой — четверть круга от косяка внутрь помещения
              const [dx, dy] = door;
              const swing: Box = dy === 0 ? [dx, 0.5, dx + 0.92, 1.42] : dy === h - 1 ? [dx, h - 1.42, dx + 0.92, h - 0.5] : dx === 0 ? [0.5, dy, 1.42, dy + 0.92] : [w - 1.42, dy, w - 0.5, dy + 0.92];
              expect({ type, w, h, door, cell, onDoor: cross(badge, swing.map(v => v * cell) as Box) }).toEqual({ type, w, h, door, cell, onDoor: false });
              const l = roomLabel(name, r, cell, top);
              const text = Math.min(l.width, (l.lines === 2 ? longestLine(name) : name.length) * GLYPH * l.fontSize);
              const label: Box = [l.left, l.top, l.left + text, l.top + l.lines * l.fontSize * 1.25];
              expect({ type, w, h, door, cell, onLabel: cross(badge, label) }).toEqual({ type, w, h, door, cell, onLabel: false });
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('план: куда смотрят люди', () => {
  const at = (id: string, cell: [number, number]): Placement => ({ id, figure: 'patient', look: { body: 3, head: 0 }, where: { cell }, doing: { kind: 'registration' } });

  test('идущий — по ходу, пришедший к стойке регистратуры — к стойке', () => {
    const w = new Walkers(layout, 8);
    w.sync([], 0);
    const reg = layout.spots.registration;
    w.sync([at('p1', reg)], 0);
    // первый шаг от входа — по ходу
    const start = w.where('p1', 0)!;
    const next = w.where('p1', 1 / SPEED)!;
    expect(norm(w.facing('p1', 0.5 / SPEED)!)).toBeCloseTo(norm(headingOf(next[0] - start[0], next[1] - start[1])));
    // дошёл и стоит — к столу регистратуры
    const desk = layout.objects.find(o => o.kind === 'desk' && Math.abs(o.x - reg[0]) + Math.abs(o.y - reg[1]) === 1)!;
    expect(norm(w.facing('p1', 1000)!)).toBeCloseTo(norm(headingOf(desk.x - reg[0], desk.y - reg[1])));
  });

  test('персонал на месте смотрит на свой стол', () => {
    const w = new Walkers(layout, 16);
    const staff = layout.staff.map(s => ({ id: `staff.${s.id ?? s.role}`, figure: 'staff' as const, look: { body: 2, head: 0 }, where: { cell: s.cell }, doing: { kind: 'staff' as const, role: s.role } }));
    w.sync(staff, 0);
    const reg = layout.staff.find(s => s.role === 'registrar')!;
    const desk = layout.objects.find(o => o.kind === 'desk' && Math.abs(o.x - reg.cell[0]) + Math.abs(o.y - reg.cell[1]) === 1)!;
    expect(norm(w.facing('staff.registrar', 0)!)).toBeCloseTo(norm(headingOf(desk.x - reg.cell[0], desk.y - reg.cell[1])));
  });
});

describe('план: рисунок без экрана', () => {
  const K = 4;
  const W = layout.grid.w * CELL_PX * K;
  const H = layout.grid.h * CELL_PX * K;
  let floor: Uint8Array;
  let again: Uint8Array;
  let colors: { WALL: string; CORRIDOR: string; tintOf: (t: string) => string };
  /** Цвет точки плана (в клетках), RGB. */
  const at = (px: Uint8Array, x: number, y: number) => {
    const i = (Math.floor(y * CELL_PX * K) * W + Math.floor(x * CELL_PX * K)) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const near = (a: number[], hex: string, tol = 10) => rgb(hex).every((v, i) => Math.abs(v - a[i]) <= tol);

  beforeAll(async () => {
    await loadSkia();
    const { Skia } = await import('@shopify/react-native-skia');
    const f = await import('../../src/render/map/floor');
    colors = { WALL: f.WALL, CORRIDOR: f.CORRIDOR, tintOf: f.tintOf };
    const draw = async () => {
      const rec = Skia.PictureRecorder();
      const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, H));
      c.scale(K, K);
      c.drawPicture(f.recordFloor(layout));
      return (await rasterize(rec.finishRecordingAsPicture(), W, H)).rgba;
    };
    floor = await draw();
    again = await draw();
  });

  const cells = (k: number) => {
    const out: [number, number][] = [];
    for (let y = 1; y < layout.grid.h - 1; y++) for (let x = 1; x < layout.grid.w - 1; x++) if (layout.grid.cells[y * layout.grid.w + x] === k) out.push([x, y]);
    return out;
  };
  const kind = (x: number, y: number) => layout.grid.cells[y * layout.grid.w + x];
  const roomAt = (x: number, y: number) => layout.rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)!;

  test('стена между помещением и коридором — полоса посередине, по бокам — пол помещения и коридора', () => {
    let checked = 0;
    for (const [x, y] of cells(CELL.wall)) {
      if (kind(x, y - 1) !== CELL.floor || kind(x, y + 1) !== CELL.corridor) continue;
      expect(near(at(floor, x + 0.5, y + 0.5), colors.WALL)).toBe(true);
      expect(near(at(floor, x + 0.5, y + 0.12), colors.tintOf(roomAt(x, y - 1).type), 4)).toBe(true);
      expect(near(at(floor, x + 0.5, y + 0.88), colors.CORRIDOR, 4)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  test('дверь — проём: в клетке двери пол помещения и коридора, а не стена', () => {
    let checked = 0;
    for (const [x, y] of cells(CELL.door)) {
      if (kind(x, y - 1) !== CELL.floor || kind(x, y + 1) !== CELL.corridor) continue;
      expect(near(at(floor, x + 0.5, y + 0.3), colors.tintOf(roomAt(x, y - 1).type), 4)).toBe(true);
      expect(near(at(floor, x + 0.5, y + 0.7), colors.CORRIDOR, 4)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });

  test('наружная стена толще внутренней', () => {
    // сколько тёмных точек поперёк стены: сверху вниз через середину клетки
    const dark = (x: number, y: number) => {
      let n = 0;
      for (let py = Math.floor(y * CELL_PX * K); py < (y + 1) * CELL_PX * K; py++) {
        const i = (py * W + Math.floor((x + 0.5) * CELL_PX * K)) * 4;
        if (near([floor[i], floor[i + 1], floor[i + 2]], colors.WALL, 12)) n++;
      }
      return n;
    };
    const cellPx = CELL_PX * K;
    // верхняя стена помещения у края участка — наружная; стена над коридором — внутренняя
    const top = layout.rooms.find(r => r.y === 0)!;
    const inner = cells(CELL.wall).find(([x, y]) => kind(x, y - 1) === CELL.floor && kind(x, y + 1) === CELL.corridor)!;
    expect(Math.abs(dark(inner[0], inner[1]) - WALL_IN * cellPx)).toBeLessThanOrEqual(2);
    expect(Math.abs(dark(top.x + 2, 0) - WALL_OUT * cellPx)).toBeLessThanOrEqual(2);
  });

  test('та же запись — те же байты', () => {
    expect(Buffer.from(again).equals(Buffer.from(floor))).toBe(true);
  });
});

describe('план: атлас без экрана', () => {
  const PX = 64;
  let pixels: Uint8Array;
  let width: number;
  let atlas: Awaited<ReturnType<typeof import('../../src/render/map/sprites')['buildAtlas']>>;
  let kinds: readonly string[];
  let lit: readonly string[];

  beforeAll(async () => {
    await loadSkia();
    const { Skia } = await import('@shopify/react-native-skia');
    const s = await import('../../src/render/map/sprites');
    atlas = s.buildAtlas(PX);
    kinds = s.OBJECT_KINDS;
    lit = s.LIT_KINDS;
    width = atlas.image.width();
    const height = atlas.image.height();
    const rec = Skia.PictureRecorder();
    const c = rec.beginRecording(Skia.XYWHRect(0, 0, width, height));
    const white = Skia.Paint();
    white.setColor(Skia.Color('#FFFFFF'));
    c.drawRect(Skia.XYWHRect(0, 0, width, height), white);
    c.drawImage(atlas.image, 0, 0);
    pixels = (await rasterize(rec.finishRecordingAsPicture(), width, height)).rgba;
  });

  /** Цвет точки (u, v — доли клетки) в клетке атласа `r`. */
  const pick = (r: { x: number; y: number }, u: number, v: number) => {
    const i = ((Math.floor(r.y) + Math.floor(v * PX)) * width + Math.floor(r.x) + Math.floor(u * PX)) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  };
  const block = (r: { x: number; y: number }) => {
    const out: number[] = [];
    for (let v = 0; v < PX; v++) for (let u = 0; u < PX; u++) out.push(...pick(r, u / PX, v / PX));
    return out.join(',');
  };
  const near = (a: number[], hex: string, tol = 12) => rgb(hex).every((v, i) => Math.abs(v - a[i]) <= tol);

  test('у каждого предмета и аппарата свой рисунок; у каждого аппарата базы — есть', () => {
    const seen = new Set(kinds.map(k => block(atlas.objectRect(k as never))));
    expect(seen.size).toBe(kinds.length);
    for (const e of Object.values(db.equipment)) expect(kinds).toContain(e.sprite);
  });

  test('у аппаратов ЭКГ, анализатора и рентгена — рисунок «работает»: светлый экран, горящая трубка', () => {
    const all = new Set(kinds.map(k => block(atlas.objectRect(k as never))));
    for (const k of lit) {
      const on = block(atlas.objectRect(k as never, true));
      expect(on).not.toBe(block(atlas.objectRect(k as never)));
      all.add(on);
    }
    expect(all.size).toBe(kinds.length + lit.length);
    // экран ЭКГ и анализатора: погашен — тёмный, работает — светлый; трубка рентгена — жёлтая
    expect(near(pick(atlas.objectRect('ecg' as never), 0.32, 0.3), '#2F3B3E')).toBe(true);
    expect(near(pick(atlas.objectRect('ecg' as never, true), 0.32, 0.3), '#CFF5E2')).toBe(true);
    expect(near(pick(atlas.objectRect('analyzer' as never, true), 0.7, 0.25), '#CFF5E2')).toBe(true);
    expect(near(pick(atlas.objectRect('xray' as never, true), 0.5, 0.5), '#FFE9A3')).toBe(true);
  });

  test('тело врача — белое, медсестры — голубое, пациента — цвета его одежды; красный обод — у срочного', () => {
    expect(near(pick(atlas.bodyRect(bodyIndex({ uniform: 'doctor' })), 0.5, 0.4), '#FFFFFF')).toBe(true);
    expect(near(pick(atlas.bodyRect(bodyIndex({ uniform: 'nurse' })), 0.5, 0.4), '#6FA8DC')).toBe(true);
    CLOTHES.forEach((color, c) => {
      expect(near(pick(atlas.bodyRect(bodyIndex({ clothes: c, urgency: 0 })), 0.5, 0.4), color)).toBe(true);
    });
    // обод — снаружи плеч: у срочного красный, у обычного там пусто
    expect(near(pick(atlas.bodyRect(bodyIndex({ clothes: 0, urgency: 2 })), 0.5, 0.085), '#C8453C', 30)).toBe(true);
    expect(near(pick(atlas.bodyRect(bodyIndex({ clothes: 0, urgency: 0 })), 0.5, 0.085), '#FFFFFF', 4)).toBe(true);
  });

  test('волосы головы — цвета волос портрета, спереди — полоска лица', () => {
    HAIRS.forEach((hair, h) => {
      const r = atlas.headRect(headIndex(1, h, 'short'));
      expect(near(pick(r, 0.5, 0.4), hair)).toBe(true);
      expect(near(pick(r, 0.5, 0.635), SKIN[1], 16)).toBe(true);
    });
  });
});
