// Пол, стены и двери записываются один раз в SkPicture и перерисовываются только после
// стройки (06-architecture.md §6).
import { Skia, type SkPicture } from '@shopify/react-native-skia';
import { CELL, type HospitalLayout, type RoomType } from '@/engine/hospital/grid';

export const CELL_PX = 16;

const ROOM_TINT: Record<RoomType, string> = {
  reception: '#FAF1E4', waiting: '#FAF6E8', office: '#E7F3F2', triage: '#F8ECEC', procedure: '#F8ECEC',
  lab: '#F1ECF8', ecg: '#EEF5E6', xray: '#E9ECED', ultrasound: '#EEF5E6', ward: '#ECEFF9',
  surgery: '#E4F3EA', staff: '#F3F0EA', toilet: '#E8EFF5',
};

/** Помещения — из плана стройки (`room.lab`) или прежней записи (`lab`): оттенок один. */
type FloorRoom = { type: string; x: number; y: number; w: number; h: number };
const tintOf = (type: string) => ROOM_TINT[(type.startsWith('room.') ? type.slice(5) : type) as RoomType] ?? '#F3F0EA';

export function recordFloor(layout: Pick<HospitalLayout, 'grid'> & { rooms: FloorRoom[] }): SkPicture {
  const { grid, rooms } = layout;
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, grid.w * CELL_PX, grid.h * CELL_PX));
  const paint = (color: string) => {
    const p = Skia.Paint();
    p.setColor(Skia.Color(color));
    return p;
  };
  const outside = paint('#DDE4E3');
  const corridor = paint('#F6F3ED');
  const wall = paint('#46575C');
  const door = paint('#C9AE82');
  c.drawRect(Skia.XYWHRect(0, 0, grid.w * CELL_PX, grid.h * CELL_PX), outside);
  for (const r of rooms) {
    c.drawRect(Skia.XYWHRect(r.x * CELL_PX, r.y * CELL_PX, r.w * CELL_PX, r.h * CELL_PX), paint(tintOf(r.type)));
  }
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const k = grid.cells[y * grid.w + x];
      const rect = Skia.XYWHRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
      if (k === CELL.corridor) c.drawRect(rect, corridor);
      else if (k === CELL.wall) c.drawRect(rect, wall);
      else if (k === CELL.door) c.drawRect(rect, door);
    }
  }
  return rec.finishRecordingAsPicture();
}

/** Сетка клеток участка — на экране стройки видно, куда встанет помещение. */
export function recordGridLines(w: number, h: number): SkPicture {
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, w * CELL_PX, h * CELL_PX));
  const p = Skia.Paint();
  p.setColor(Skia.Color('rgba(40, 60, 64, 0.12)'));
  p.setStrokeWidth(0.6);
  for (let x = 0; x <= w; x++) c.drawLine(x * CELL_PX, 0, x * CELL_PX, h * CELL_PX, p);
  for (let y = 0; y <= h; y++) c.drawLine(0, y * CELL_PX, w * CELL_PX, y * CELL_PX, p);
  return rec.finishRecordingAsPicture();
}
