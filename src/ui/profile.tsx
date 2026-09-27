// Имя и пол врача: при первом запуске, после оговорки, и из профиля. Имя уже подставлено — из
// тех же списков, что у пациентов, — его можно оставить, поменять или взять другое.
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { Text, TextInput } from './text';
import { T } from '@/i18n';
import type { Doctor } from '@/state/profile';
import { suggestDoctor } from '@/state/profileView';
import { Button, Card, H, P, Screen, Tabs } from './components';
import { colors, radius, space, touch } from './theme';

const MAX = 30;

export function DoctorForm({ initial, submitTitle, onSubmit }: { initial?: Doctor; submitTitle: string; onSubmit: (d: Doctor) => void }) {
  const t = T.profile;
  const [d, setD] = useState<Doctor>(() => initial ?? suggestDoctor(Math.random() < 0.5 ? 'f' : 'm', Math.random));
  // пока имя не трогали, смена пола подставляет подходящее имя
  const [edited, setEdited] = useState(initial !== undefined);
  const ok = d.first.trim().length > 0 && d.last.trim().length > 0;
  const onSex = (sex: 'm' | 'f') => setD(edited ? { ...d, sex } : suggestDoctor(sex, Math.random));
  const another = () => {
    setEdited(false);
    setD(suggestDoctor(d.sex, Math.random));
  };
  return (
    <Screen footer={<Button testID="doctor-submit" title={submitTitle} disabled={!ok} onPress={() => onSubmit(d)} />}>
      <Card>
        <H>{t.doctorTitle}</H>
        <P>{t.doctorText}</P>
        <Tabs<'m' | 'f'> testPrefix="doctor-sex" value={d.sex} onChange={onSex} items={[{ key: 'f', title: t.sex.f }, { key: 'm', title: t.sex.m }]} />
        <Text style={styles.label}>{t.first}</Text>
        <TextInput
          testID="doctor-first"
          value={d.first}
          maxLength={MAX}
          autoCorrect={false}
          autoCapitalize="words"
          onChangeText={first => {
            setEdited(true);
            setD({ ...d, first });
          }}
          style={styles.input}
        />
        <Text style={styles.label}>{t.last}</Text>
        <TextInput
          testID="doctor-last"
          value={d.last}
          maxLength={MAX}
          autoCorrect={false}
          autoCapitalize="words"
          onChangeText={last => {
            setEdited(true);
            setD({ ...d, last });
          }}
          style={styles.input}
        />
        <Button kind="plain" testID="doctor-another" title={t.another} onPress={another} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: space.s },
  input: {
    minHeight: touch,
    backgroundColor: colors.bg,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.l,
    fontSize: 16,
    color: colors.ink,
  },
});
