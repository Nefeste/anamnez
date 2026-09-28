// Имя, пол и портрет врача: при первом запуске, после оговорки, и из профиля. Имя уже
// подставлено — из тех же списков, что у пациентов, — его можно оставить, поменять или взять
// другое; портрет — один из шести, нарисованных кодом (spec 2026-09-profile, часть 16).
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text, TextInput } from './text';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import type { Doctor } from '@/state/profile';
import { DOCTOR_AGE, DOCTOR_PORTRAITS, suggestDoctor } from '@/state/profileView';
import { Button, Card, H, P, Screen, Tabs } from './components';
import { makeStyles, space, touch } from './theme';

const MAX = 30;

/** `bare` — без шапки: первый запуск, на месте меню. */
export function DoctorForm({ initial, submitTitle, onSubmit, bare }: { initial?: Doctor; submitTitle: string; onSubmit: (d: Doctor) => void; bare?: boolean }) {
  const styles = useStyles();
  const t = T.profile;
  const [d, setD] = useState<Doctor>(() => initial ?? suggestDoctor(Math.random() < 0.5 ? 'f' : 'm', Math.random));
  // пока имя не трогали, смена пола подставляет подходящее имя
  const [edited, setEdited] = useState(initial !== undefined);
  const ok = d.first.trim().length > 0 && d.last.trim().length > 0;
  // портрет выбран отдельно: смена пола и «другое имя» его не сбрасывают
  const keep = (x: Doctor): Doctor => (d.portrait === undefined ? x : { ...x, portrait: d.portrait });
  const onSex = (sex: 'm' | 'f') => setD(edited ? { ...d, sex } : keep(suggestDoctor(sex, Math.random)));
  const another = () => {
    setEdited(false);
    setD(keep(suggestDoctor(d.sex, Math.random)));
  };
  return (
    <Screen bare={bare} footer={<Button testID="doctor-submit" title={submitTitle} disabled={!ok} onPress={() => onSubmit(d)} />}>
      <Card>
        <H>{t.doctorTitle}</H>
        <P>{t.doctorText}</P>
        <Tabs<'m' | 'f'> testPrefix="doctor-sex" value={d.sex} onChange={onSex} items={[{ key: 'f', title: t.sex.f }, { key: 'm', title: t.sex.m }]} />
        <Text style={styles.label}>{t.portrait}</Text>
        <View style={styles.portraits} accessibilityRole="radiogroup">
          {DOCTOR_PORTRAITS[d.sex].map((seed, i) => {
            const on = (d.portrait ?? 0) === i;
            return (
              <Pressable
                key={i}
                testID={`doctor-portrait-${i}`}
                accessibilityRole="radio"
                accessibilityLabel={t.portraitN(i + 1)}
                aria-checked={on}
                onPress={() => setD({ ...d, portrait: i })}
                style={styles.portrait}>
                <View style={[styles.frame, on && styles.frameOn]}>
                  <Portrait seed={seed} sex={d.sex} age={DOCTOR_AGE} size={52} />
                </View>
              </Pressable>
            );
          })}
        </View>
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

const useStyles = makeStyles(t => ({
  // по три в ряд — два ровных ряда на любом экране
  portraits: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.s },
  portrait: { width: '33.33%', minHeight: touch, alignItems: 'center', justifyContent: 'center' },
  frame: { padding: 3, borderRadius: t.shape.radius, borderWidth: 2, borderColor: 'transparent' },
  frameOn: { borderColor: t.colors.accent },
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
  input: {
    minHeight: touch,
    backgroundColor: t.colors.bg,
    borderRadius: t.shape.radius,
    borderWidth: 1,
    borderColor: t.colors.line,
    paddingHorizontal: space.l,
    fontSize: 16,
    color: t.colors.ink,
  },
}));
