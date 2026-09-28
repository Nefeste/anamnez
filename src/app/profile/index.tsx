// Профиль (spec 2026-09-first-shift, «Профиль-минимум»): имя, портрет и звание врача
// (spec 2026-09-profile, часть 16), итоги, достижения (spec 2026-09-campaign, часть 13) и архив
// последних 50 приёмов — каждый открывается тем же разбором, что в итогах дня.
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/ui/text';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import { loadProfile, useProfile } from '@/state/profile';
import { achievementCount, archiveRows, DOCTOR_AGE, doctorName, portraitSeed, practiceLines, rankLadder, rankName } from '@/state/profileView';
import { CaseRow } from '@/ui/case/CaseRow';
import { Button, Card, P, Screen } from '@/ui/components';
import { colors, space } from '@/ui/theme';

export default function ProfileScreen() {
  const p = useProfile();
  useEffect(() => {
    loadProfile();
  }, []);
  const t = T.profile;
  const lines = practiceLines(p);
  const rows = archiveRows(p.archive);
  const got = achievementCount(p);
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
      <Card>
        <Text style={styles.label}>{t.practice}</Text>
        {lines.length === 0 ? <P muted>{t.noCases}</P> : lines.map((l, i) => <P key={i} testID={`profile-line-${i}`}>{l}</P>)}
      </Card>
      <Card>
        <Text style={styles.label}>{t.achievements}</Text>
        <Button kind="plain" testID="profile-achievements" title={t.achievementsOpen} hint={t.achievementsCount(got.got, got.total)}
          onPress={() => router.push('/profile/achievements')} />
      </Card>
      <Card>
        <Text style={styles.label}>{t.archive}</Text>
        <P muted>{t.archiveHint}</P>
        {rows.length === 0 ? <P muted>{t.archiveEmpty}</P> : rows.map(r => (
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
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  fill: { flex: 1 },
  name: { fontSize: 22, fontWeight: '700', color: colors.ink },
  rank: { fontSize: 15, fontWeight: '600', color: colors.accent, marginTop: 2 },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
});
