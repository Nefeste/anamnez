// Выбор сложности (09-game-design.md §14): при начале практики и при «Начать заново»; с 0.5.4 — и «Практикант»,
// самый простой (spec 2026-10-trainee); с 0.5.8 — «Ординатор» между «Студентом» и «Врачом» (spec 2026-10-resident).
import { Text } from './text';
import type { Difficulty } from '@/engine/shift/types';
import { T } from '@/i18n';
import { P, Tabs } from './components';
import { makeStyles, space } from './theme';

export function DifficultyChoice({ value, onChange }: { value: Difficulty; onChange: (d: Difficulty) => void }) {
  const styles = useStyles();
  const t = T.shift.difficulty;
  return (
    <>
      <Text style={styles.label}>{t.title}</Text>
      <Tabs<Difficulty> testPrefix="difficulty" value={value} onChange={onChange}
        items={[{ key: 'trainee', title: t.trainee }, { key: 'student', title: t.student }, { key: 'resident', title: t.resident }, { key: 'doctor', title: t.doctor }]} />
      <P muted testID="difficulty-text">{t[`${value}Text`]}</P>
    </>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
}));
