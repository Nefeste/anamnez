// Выбор сложности (03-game-design.md §14): при начале практики и при «Начать заново».
import { StyleSheet, Text } from 'react-native';
import type { Difficulty } from '@/engine/shift/types';
import { T } from '@/i18n';
import { P, Tabs } from './components';
import { colors, space } from './theme';

export function DifficultyChoice({ value, onChange }: { value: Difficulty; onChange: (d: Difficulty) => void }) {
  const t = T.shift.difficulty;
  return (
    <>
      <Text style={styles.label}>{t.title}</Text>
      <Tabs<Difficulty> testPrefix="difficulty" value={value} onChange={onChange} items={[{ key: 'student', title: t.student }, { key: 'doctor', title: t.doctor }]} />
      <P muted testID="difficulty-text">{value === 'student' ? t.studentText : t.doctorText}</P>
    </>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: space.s },
});
