// «Спросить» беседой (spec 2026-10-patient-card, 0.6.0): у каждого расспроса базы — вопрос врача живой речью, лишних
// нет; реплика пациента — найденное первым, из «нет» — до трёх, остальное — числом; вопросы — «О жалобах» и «О жизни».
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { T } from '../../src/i18n';
import { examsByAction, type Line, lifeHistory, withoutRepeats } from '../../src/state/caseView';
import { joinSaid, NO_SAID, replyOf } from '../../src/ui/case/reply';

const asks = Object.values(db.exams).filter(e => e.kind === 'ask').map(e => e.id).sort();
const line = (text: string, shown: boolean): Line => ({ f: `hx.${text}`, shown, exam: 'exam.ask_onset', text });

describe('беседа', () => {
  test('у каждого расспроса базы — вопрос врача, лишних нет', () => {
    expect(Object.keys(T.spikes.talk.questions).sort()).toEqual(asks);
    for (const [id, q] of Object.entries(T.spikes.talk.questions)) {
      // вопрос — не название расспроса: «Есть аллергия?», а не «Аллергии»
      expect({ id, same: q === db.exams[id].name.ru }).toEqual({ id, same: false });
      expect({ id, q: /^[А-ЯЁ]/.test(q) && !/[.!]$/.test(q) }).toEqual({ id, q: true });
    }
  });

  test('реплика: найденное — первым, из «нет» — до трёх, остальное — числом; раскрытая — всё', () => {
    const lines = [line('нет1', false), line('есть1', true), line('нет2', false), line('нет3', false), line('нет4', false), line('есть2', true), line('нет5', false)];
    const short = replyOf(lines, false);
    expect(short.said.map(l => l.text)).toEqual(['есть1', 'есть2', 'нет1', 'нет2', 'нет3']);
    expect(short.more).toBe(2);
    expect(NO_SAID).toBe(3);
    const all = replyOf(lines, true);
    expect(all.said.map(l => l.text)).toEqual(['есть1', 'есть2', 'нет1', 'нет2', 'нет3', 'нет4', 'нет5']);
    expect(all.more).toBe(0);
    expect(replyOf([], false)).toEqual({ said: [], more: 0 });
  });

  test('фразы реплики — одной речью: точка между ними, своя не удваивается', () => {
    expect(joinSaid(['Кашля нет', 'Температура 38', 'Горло болит'])).toEqual(['Кашля нет.', 'Температура 38.', 'Горло болит']);
    expect(joinSaid(['Началось внезапно.', 'Неделю назад'])).toEqual(['Началось внезапно.', 'Неделю назад']);
  });

  // часть 103 (spec 2026-10-publish-ready): в ответе нет «Сон обычный. … Сон обычный, дни не путает»
  test('ответ без повторов: «нет», сказанное другим «нет», — один раз; найденное не трогается', () => {
    const lines = [
      line('Зрачки обычной ширины', false), line('Зрачки обычной ширины, на свет реагируют живо', false), line('Голова не болит', false),
      line('Голова не болит.', false), line('Голова не кружится', false), line('Зрачки обычной ширины', true),
    ];
    expect(withoutRepeats(lines).map(l => [l.text, l.shown])).toEqual([
      ['Зрачки обычной ширины, на свет реагируют живо', false], ['Голова не болит', false], ['Голова не кружится', false],
      ['Зрачки обычной ширины', true],
    ]);
  });

  // часть 103: у признаков одного расспроса «нет» разные
  test('в базе у признаков одного расспроса — разные «нет»', () => {
    for (const id of asks) {
      const said = db.exams[id].checks.flatMap(c => (db.findings[c.f]?.texts.absent ?? []).map(t => t.ru.toLowerCase()));
      expect({ id, dupes: said.filter((x, i) => said.indexOf(x) !== i) }).toEqual({ id, dupes: [] });
    }
  });

  test('вопросы о жизни — после вопросов о жалобах, как в списке расспроса', () => {
    const ask = examsByAction({ sex: 'f', age: 40, complaints: ['sym.fever'] }).ask;
    const firstLife = ask.findIndex(lifeHistory);
    expect(firstLife).toBeGreaterThan(0);
    expect(ask.slice(firstLife).every(lifeHistory)).toBe(true);
    expect(lifeHistory('exam.ask_allergies')).toBe(true);
    expect(lifeHistory('exam.ask_onset')).toBe(false);
  });
});
