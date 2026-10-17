// Профиль (spec 2026-09-first-shift, «Профиль-минимум»): имя, портрет и звание врача
// (spec 2026-09-profile, часть 16), итоги, достижения (spec 2026-09-campaign, часть 13) и архив
// последних 50 приёмов — каждый открывается тем же разбором, что в итогах дня. С 0.6.2 (просьба владельца 16.10.2026:
// «прибраться и сделать в лучших практиках data visualization») итоги — плитками, шкалами и полосами: главное — цифрой
// сверху, доли — шкалой от предела, итог диагноза — частями одной полосы со значками; каждое число подписано. Звание и
// достижения — строкой, как прежде: шкала «до следующего» стала бы тем «осталось», которого профиль не показывает.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import { loadProfile, useProfile } from '@/state/profile';
import {
  achievementCount, archiveRows, DOCTOR_AGE, doctorName, pctOf, portraitSeed, practiceView, rankLadder, rankName, skillRows, specialtyRows,
} from '@/state/profileView';
import { useSettings } from '@/state/settings';
import { CaseRow } from '@/ui/case/CaseRow';
import { BarList, Meter, StackBar, StatTile } from '@/ui/charts';
import { Button, Card, P, Screen } from '@/ui/components';
import { Text } from '@/ui/text';
import { makeStyles, space, useTheme } from '@/ui/theme';

/** Сколько приёмов архива на виду сразу; остальное — по касанию. */
const ARCHIVE_SHOWN = 10;

export default function ProfileScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const p = useProfile();
  useEffect(() => {
    loadProfile();
  }, []);
  const [allCases, setAllCases] = useState(false);
  const t = T.profile;
  const v = practiceView(p);
  const rows = archiveRows(p.archive);
  const got = achievementCount(p);
  const skillsOn = useSettings().skills;
  const skills = skillRows(p);
  const c = theme.colors;
  return (
    <Screen>
      <Card>
        <View style={styles.head}>
          {p.doctor ? <Portrait seed={portraitSeed(p.doctor)} sex={p.doctor.sex} age={DOCTOR_AGE} size={64} /> : null}
          <View style={styles.fill}>
            <Text testID="profile-name" style={styles.name}>{p.doctor ? doctorName(p.doctor) : t.title}</Text>
            <Text testID="profile-rank" style={styles.rank}>{rankName(p.stats.cases)}</Text>
          </View>
        </View>
        <P muted>{rankLadder()}</P>
        <Button kind="plain" testID="profile-edit" title={t.edit} onPress={() => router.push('/profile/doctor')} />
      </Card>

      {v ? (
        <>
          {/* главное — цифрами, плитками в два ряда */}
          <View style={styles.tiles}>
            <StatTile testID="kpi-cases" label={t.kpi.cases} value={String(v.cases)} />
            <StatTile testID="kpi-correct" label={t.kpi.correct} value={t.percent(v.correctPct)} />
            {v.minutes !== undefined ? <StatTile testID="kpi-minutes" label={t.kpi.minutes} value={t.minutesValue(v.minutes)} /> : null}
            <StatTile testID="kpi-money" label={t.kpi.money} value={T.common.rub(v.money)} />
          </View>
          <Card>
            <Text style={styles.label}>{t.diagnoses}</Text>
            <StackBar testID="profile-verdicts" label={t.diagnoses} parts={(['correct', 'partly', 'wrong'] as const).map(k => ({
              key: k, value: v.verdicts[k], color: k === 'correct' ? c.good : k === 'partly' ? c.warn : c.bad, icon: t.verdictIcon[k], label: t.verdict[k],
              text: t.share(v.verdicts[k], pctOf(v.verdicts[k], v.cases)),
            }))} />
            <P testID="profile-seen">{t.seen(v.seen.n, v.seen.of)}</P>
          </Card>
          <Card>
            <Text style={styles.label}>{t.gradesTitle}</Text>
            <BarList testID="profile-grades" label={t.gradesTitle} rows={(['A', 'B', 'C', 'D'] as const).map(g => ({ key: g, label: g, value: v.grades[g] }))} />
          </Card>
          {v.antibiotics || v.danger ? (
            <Card>
              <Text style={styles.label}>{t.care}</Text>
              <View style={styles.meters}>
                {v.antibiotics ? (
                  <Meter testID="profile-antibiotics" label={t.antibiotics} value={v.antibiotics.ok} max={v.antibiotics.of} text={t.outOf(v.antibiotics.ok, v.antibiotics.of)} />
                ) : null}
                {v.danger ? <Meter testID="profile-danger" label={t.danger} value={v.danger.ok} max={v.danger.of} text={t.outOf(v.danger.ok, v.danger.of)} /> : null}
              </View>
            </Card>
          ) : null}
        </>
      ) : (
        <Card>
          <Text style={styles.label}>{t.practice}</Text>
          <P muted testID="profile-empty">{t.noCases}</P>
        </Card>
      )}

      <Card>
        <Text style={styles.label}>{t.specialties}</Text>
        <View style={styles.meters}>
          {specialtyRows(p).map(r => (
            <Meter key={r.department} testID={`specialty-${r.department}`} label={r.name} value={r.of !== undefined ? r.points - r.from : 1}
              max={r.of !== undefined ? r.of - r.from : 1} text={r.level} hint={r.hint} />
          ))}
        </View>
        <Text style={[styles.label, styles.gap]}>{t.skills}</Text>
        {skills.length === 0 ? <P muted>{t.skillsNone}</P> : skills.map(s => <P key={s.id} testID={`skill-${s.id}`}>{s.line}</P>)}
        <P muted testID="profile-skills-note">{skillsOn ? t.skillsNote : t.skillsOff}</P>
      </Card>

      <Card>
        <Text style={styles.label}>{t.achievements}</Text>
        <Button kind="plain" testID="profile-achievements" title={t.achievementsOpen} hint={t.achievementsCount(got.got, got.total)}
          onPress={() => router.push('/profile/achievements')} />
      </Card>

      <Card>
        <Text style={styles.label}>{t.archive}</Text>
        <P muted>{t.archiveHint}</P>
        {rows.length === 0 ? <P muted>{t.archiveEmpty}</P> : (allCases ? rows : rows.slice(0, ARCHIVE_SHOWN)).map(r => (
          <CaseRow
            key={r.key}
            testID={`archive-${r.key}`}
            verdict={r.verdict}
            title={r.title}
            subtitle={r.diagnosis}
            grade={r.overall}
            onPress={() => router.push({ pathname: '/profile/case/[key]', params: { key: r.key } })}
          />
        ))}
        {rows.length > ARCHIVE_SHOWN ? (
          <Button kind="plain" testID="profile-archive-more" title={allCases ? t.archiveLess : t.archiveMore(rows.length)} onPress={() => setAllCases(!allCases)} />
        ) : null}
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  fill: { flex: 1 },
  name: { fontSize: 22, fontWeight: '700', color: t.colors.ink },
  rank: { fontSize: 15, fontWeight: '600', color: t.colors.accent, marginTop: 2 },
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
  gap: { marginTop: space.s },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  meters: { gap: space.m },
}));
