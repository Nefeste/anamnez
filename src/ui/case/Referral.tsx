// «Назначить» бланком направления (spec 2026-10-patient-card, 0.6.0; ответ владельца на вопрос 45): разделы бланка
// свёрнуты, есть поиск по названию; обследования отмечают галочками, «Отправить» внизу назначает отмеченное разом.
// Отправленное — со временем, когда будет; пришедшее — ответом на месте строки, как и прежде, и на «Карте».
import { Fragment, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { db } from '@/content';
import { T } from '@/i18n';
import { examInfo, examTerm, type TermInfo, type VisitView } from '@/state/caseView';
import { matchesQuery } from '@/state/encyclopedia';
import { examIcon } from '@/ui/itemIcons';
import { P } from '@/ui/components';
import { makeStyles, space, touch } from '@/ui/theme';
import { TextInput } from '../text';
import { ExamRow } from './ExamRow';
import { CheckRow, SectionHead } from './FormRow';
import { SECTIONS, sectionOf } from './sections';

/** Разделы бланка по порядку; «Практикант» — сначала «По жалобе». Пустых нет. */
export function partsOf(ids: readonly string[], focus?: ReadonlySet<string>): { key: string; ids: string[] }[] {
  const hot = focus ? ids.filter(id => focus.has(id)) : [];
  return [
    { key: 'focus', ids: hot },
    ...SECTIONS.map(key => ({ key, ids: ids.filter(id => !hot.includes(id) && sectionOf(db.exams[id]) === key) })),
  ].filter(x => x.ids.length > 0);
}

/** Сколько ждать отмеченного: самое долгое — минуты у постели, с умениями дня или по базе. */
export function longestOf(v: VisitView, ids: readonly string[]): number {
  return Math.max(0, ...ids.map(id => v.bedside?.[id] ?? v.minutes?.[id] ?? examInfo(id).minutes));
}

/**
 * Бланк — одним столбцом: заголовок раздела, под ним строки; строки — прямо в столбце, поэтому карта знает, где
 * каждая, и ставит новый ответ посередине (0.5.20).
 */
export function Referral({ v, ids, focus, marked, onMark, isOpen, toggle, explain, onRow }: {
  v: VisitView; ids: readonly string[];
  /** «Практикант»: что относится к жалобе — первым разделом, раскрытым */
  focus?: ReadonlySet<string>;
  marked: readonly string[]; onMark: (id: string) => void;
  isOpen: (key: string) => boolean; toggle: (key: string) => void;
  explain: (info: TermInfo) => void;
  /** где легла сделанная строка — к ответу после действия */
  onRow: (id: string, e: LayoutChangeEvent) => void;
}) {
  const styles = useStyles();
  const t = T.spikes.referral;
  const [query, setQuery] = useState('');
  const fresh = (id: string) => v.groups.some(g => g.exam === id && g.fresh);
  const found = query.trim() ? ids.filter(id => matchesQuery(query, examInfo(id).name)) : undefined;
  const p = T.spikes.patient;
  const row = (id: string) => {
    if (v.done.includes(id)) {
      return <ExamRow key={id} v={v} id={id} open={isOpen(`done:${id}`)} onToggle={() => toggle(`done:${id}`)} onExam={onMark} explain={explain} onLayout={e => onRow(id, e)}
        indent={!found} />;
    }
    // не сделать здесь — серым, с причиной; у постели — так и сказано
    const info = examInfo(id);
    const why = v.unavailable[id];
    const hint = why ?? (v.bedside?.[id] !== undefined ? p.costBedside(v.bedside[id], info.cost) : p.cost(v.minutes?.[id] ?? info.minutes, info.cost));
    return (
      <CheckRow key={id} testID={`exam-${id}`} title={info.name} hint={hint} hintMono={!why} on={marked.includes(id)} disabled={!!why} onPress={() => onMark(id)}
        onInfo={() => explain(examTerm(id))} infoLabel={p.whatIsIt} indent={!found} icon={{ icon: examIcon(id), state: 'unknown' }} />
    );
  };
  return (
    <>
      <TextInput testID="order-search" value={query} onChangeText={setQuery} placeholder={t.search} autoCorrect={false} returnKeyType="search"
        clearButtonMode="while-editing" style={styles.search} />
      {found ? (found.length > 0 ? found.map(row) : <P muted>{t.nothing}</P>) : (
        <>
          {focus && <P muted testID="visit-focus">{T.spikes.patient.focusNote}</P>}
          {partsOf(ids, focus).map(s => {
            // «По жалобе» раскрыт, пока его не свернули; раздел с новым ответом — раскрыт, чтобы ответ был на виду
            const open = (s.key === 'focus' ? !isOpen('sec:focus') : isOpen(`sec:${s.key}`)) || s.ids.some(fresh);
            const done = s.ids.filter(id => v.done.includes(id)).length;
            const marks = s.ids.filter(id => marked.includes(id)).length;
            return (
              <Fragment key={s.key}>
                <SectionHead testID={`order-sec-${s.key}`} title={t.sections[s.key]} state={t.state(marks, done, s.ids.length)} marked={marks > 0}
                  open={open} onPress={() => toggle(`sec:${s.key}`)} />
                {open ? s.ids.map(row) : null}
              </Fragment>
            );
          })}
        </>
      )}
    </>
  );
}

const useStyles = makeStyles(t => ({
  search: {
    minHeight: touch, backgroundColor: t.colors.card, borderRadius: t.shape.radius, borderWidth: 1, borderColor: t.colors.line,
    paddingHorizontal: space.l, fontSize: 16, color: t.colors.ink,
  },
}));
