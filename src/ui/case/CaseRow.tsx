// Строка закрытого приёма: верен ли диагноз, кто и что поставлено, оценка. Одна — в итогах дня
// и в архиве профиля.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Grade } from '@/engine/med/score';
import { T } from '@/i18n';
import { colors, space } from '../theme';
import { gradeColor } from './OutcomeScreen';

export function CaseRow({ verdict, title, subtitle, grade, onPress, testID }: {
  verdict: 'correct' | 'partly' | 'wrong';
  title: string;
  subtitle: string;
  grade: Grade;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <Text style={styles.verdict}>{T.shift.verdict[verdict]}</Text>
      <View style={styles.text}>
        <Text style={styles.name}>{title}</Text>
        <Text style={styles.meta}>{subtitle}</Text>
      </View>
      <Text style={[styles.grade, gradeColor(grade)]}>{grade}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: colors.line },
  pressed: { opacity: 0.8 },
  verdict: { width: 20, fontSize: 18, textAlign: 'center', color: colors.ink },
  text: { flex: 1, gap: 2 },
  name: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.ink },
  meta: { fontSize: 13, color: colors.muted },
  grade: { fontSize: 22, fontWeight: '800' },
});
