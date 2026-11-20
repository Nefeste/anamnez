// Разметка снимков приёма (spec 2026-11-xray-marks): как показывать контуры находок и куда записать попытку задачи
// «Найдите на снимке». Карта пациента и разбор кладут это в контекст: снимок глубоко в строках, а прокидывать через
// каждую строку не нужно.
import { createContext } from 'react';
import type { Look } from '@/state/caseView';

export interface CaseImages {
  mode: 'show' | 'find';
  looked: readonly Look[];
  /** смена: записать попытку; нет — задачи нет, контуры видны сразу */
  look?: (f: string, hit: boolean) => void;
}

export const CaseImagesContext = createContext<CaseImages>({ mode: 'show', looked: [] });
