// Профиль (spec 2026-09-first-shift, «Профиль-минимум»): имя врача, итоги практики и архив
// последних 50 приёмов — каждый открывается тем же разбором, что в итогах дня.
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { Text } from '@/ui/text';
import { T } from '@/i18n';
import { loadProfile, useProfile } from '@/state/profile';
import { archiveRows, doctorName, practiceLines } from '@/state/profileView';
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
  return (
    <Screen>
      <Card>
        <Text testID="profile-name" style={styles.name}>{p.doctor ? doctorName(p.doctor) : t.title}</Text>
        <Button kind="plain" testID="profile-edit" title={t.edit} onPress={() => router.push('/profile/doctor')} />
      </Card>
      <Card>
        <Text style={styles.label}>{t.practice}</Text>
        {lines.length === 0 ? <P muted>{t.noCases}</P> : lines.map((l, i) => <P key={i} testID={`profile-line-${i}`}>{l}</P>)}
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
  name: { fontSize: 22, fontWeight: '700', color: colors.ink },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
});
