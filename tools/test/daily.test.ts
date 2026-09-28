// «Случай дня» (spec 2026-09-campaign, часть 14): те же дата и база — тот же пациент, другая дата
// или база — другой; последние 30 дней, сегодня первым; засчитывается первая попытка, повтор
// ничего не меняет и говорит, чем засчитана первая; «семь случаев дня» — любые семь.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { dailyDays, dailyRows, dailySeed, dailyView, dailyVisit, dayOf, openDaily, seasonOfDay } from '../../src/state/daily';
import { achievementsBy, DAILY_KEEP, dailyKey, forgetProfile, loadProfile, PROFILE_SLOT, profile, profileSaved, recordDaily, sanitizeProfile, setProfileStore } from '../../src/state/profile';
import { memoryStore, saveSlot } from '../../src/state/saves';

let store = memoryStore();
beforeEach(() => {
  store = memoryStore();
  setProfileStore(store);
  forgetProfile();
});

/** Сыграть открытый день: один вопрос, первая гипотеза «Похоже на», домой. */
function play(dx?: string) {
  dailyVisit.act('exam.ask_complaints');
  dailyVisit.chooseDiagnosis(dx ?? dailyView().hints[0].id);
  dailyVisit.finish();
}

describe('случай дня: пациент', () => {
  test('те же дата и база — тот же пациент; другая дата или база — другой', () => {
    expect(dailySeed('2026-09-28', 14)).toBe(dailySeed('2026-09-28', 14));
    expect(dailySeed('2026-09-28', 14)).not.toBe(dailySeed('2026-09-27', 14));
    expect(dailySeed('2026-09-28', 14)).not.toBe(dailySeed('2026-09-28', 13));
    openDaily('2026-09-28');
    const first = dailyView();
    openDaily('2026-09-27');
    const other = dailyView();
    openDaily('2026-09-28');
    const again = dailyView();
    expect([again.title, again.complaints]).toEqual([first.title, first.complaints]);
    expect([other.title, other.complaints]).not.toEqual([first.title, first.complaints]);
  });

  test('последние 30 дней — сегодня первым, через границу месяца; время года — по месяцу', () => {
    const days = dailyDays(new Date(2026, 2, 1));
    expect(days.length).toBe(30);
    expect(days.slice(0, 3)).toEqual(['2026-03-01', '2026-02-28', '2026-02-27']);
    expect(dayOf(new Date(2026, 8, 5))).toBe('2026-09-05');
    expect([seasonOfDay('2026-01-10'), seasonOfDay('2026-04-10'), seasonOfDay('2026-07-10'), seasonOfDay('2026-10-10')]).toEqual(['winter', 'spring', 'summer', 'autumn']);
  });
});

describe('случай дня: первая попытка', () => {
  test('засчитывается первая; повтор — тот же пациент, запись прежняя, на итоге — чем засчитана первая', async () => {
    await loadProfile();
    openDaily('2026-09-28');
    play();
    const rec = profile().daily['2026-09-28'];
    expect(rec).toMatchObject({ base: db.contentVersion, verdict: dailyView().decision!.verdict, grade: dailyView().decision!.overall });
    expect(dailyView().firstTry).toBeUndefined();
    const today = dailyRows(profile().daily, new Date(2026, 8, 28))[0];
    expect([today.title, today.played, today.hint.startsWith('Сыгран: ')]).toEqual(['Сегодня', true, true]);
    openDaily('2026-09-28');
    expect(dailyView().decision).toBeUndefined();
    play('cond.appendicitis');
    expect(profile().daily['2026-09-28']).toEqual(rec);
    expect(dailyView().firstTry).toBe(`Засчитана первая попытка: ${rec.grade}, ${{ correct: 'верно', partly: 'почти', wrong: 'неверно' }[rec.verdict]}.`);
    await profileSaved();
    forgetProfile();
    await loadProfile();
    expect(profile().daily['2026-09-28']).toEqual(rec);
  });

  test('«семь случаев дня» — любые семь, не подряд; строка — на итоге седьмого', async () => {
    await loadProfile();
    const days = ['2026-09-28', '2026-09-26', '2026-09-20', '2026-09-15', '2026-09-11', '2026-09-05', '2026-09-01'];
    for (const d of days.slice(0, 6)) {
      openDaily(d);
      play();
    }
    expect(profile().achievements.got['ach.daily_7']).toBeUndefined();
    openDaily(days[6]);
    play();
    expect(achievementsBy(dailyKey(days[6]))).toEqual(['ach.daily_7']);
    expect(dailyView().achievements).toEqual(['Семь случаев дня']);
    expect(profile().achievements.daily).toBe(7);
  });

  test('сыгранный с другой базой — в списке с её номером; хранятся последние дни; испорченное — пустым', async () => {
    await saveSlot(store, PROFILE_SLOT, { stats: {}, seen: {}, archive: [], daily: {
      '2026-09-27': { verdict: 'correct', grade: 'A', base: 3, at: 'x' },
      '2026-09-26': { verdict: 'почти', grade: 'A', base: 3, at: 'x' },
      'вчера': { verdict: 'correct', grade: 'A', base: 3, at: 'x' },
    } }, 1, 'x');
    await loadProfile();
    expect(Object.keys(profile().daily)).toEqual(['2026-09-27']);
    expect(dailyRows(profile().daily, new Date(2026, 8, 28))[1].hint).toBe('Сыгран: A · верно · база 3');
    for (let i = 0; i < DAILY_KEEP + 5; i++) recordDaily(dayOf(new Date(2026, 5, 1 + i)), { verdict: 'wrong', grade: 'D', base: 14 });
    expect(Object.keys(profile().daily).length).toBe(DAILY_KEEP);
    expect(sanitizeProfile({ daily: 'мусор' }).daily).toEqual({});
  });
});
