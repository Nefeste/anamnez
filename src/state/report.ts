// «Сообщить об ошибке» (06-architecture.md §8): текст, который игрок видит целиком и отправляет
// сам — почтой или в мессенджер; игра ничего не передаёт. В нём — версия игры и базы, телефон,
// последние сбои, зерно и журнал команд за день: по ним день переигрывается в тестах.
import type { ContentDb } from '@/content/types';
import type { ShiftState } from '@/engine/shift/types';
import { T } from '@/i18n';
import type { ErrorRecord } from './errors';

export interface ReportInput {
  description: string;
  version: string;
  build: number;
  device: string;
  db: Pick<ContentDb, 'contentVersion' | 'hash'>;
  shift?: ShiftState;
  clock?: string;
  errors: readonly ErrorRecord[];
}

export function buildReport(r: ReportInput): string {
  const t = T.report;
  const s = r.shift;
  const lines = [
    r.description.trim() || t.noDescription,
    '',
    '—',
    t.version(r.version, r.build),
    t.base(r.db.contentVersion, r.db.hash),
    t.device(r.device),
    s ? t.practice(s.day, r.clock ?? '', T.shift.difficulty[s.meta.difficulty ?? 'doctor'], s.meta.seed, s.meta.schemaVersion) : t.noPractice,
    r.errors.length === 0 ? t.noErrors : t.errors,
    ...r.errors.map(e => `${e.at}${e.fatal ? ` ${t.fatal}` : ''}: ${e.message}`),
  ];
  // журнал команд дня — одной строкой JSON: по зерну и журналу день переигрывается
  if (s) lines.push(t.journal, JSON.stringify(s.journal));
  return lines.join('\n');
}
