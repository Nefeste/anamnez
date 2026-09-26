// «Что это?» — справка простыми словами поверх экрана (03-game-design.md §5): общая для
// приёма и решения.
import { StyleSheet, Text } from 'react-native';
import { H, P, Sheet } from './components';
import { colors, space } from './theme';

export interface Term {
  title: string;
  text: string[];
  list?: { label: string; items: string[] };
}

export function TermSheet({ term, onClose, label, closeTitle }: { term: Term | null; onClose: () => void; label: string; closeTitle: string }) {
  return (
    <Sheet visible={term !== null} onClose={onClose} closeTitle={closeTitle} testID="term-sheet">
      {term && (
        <>
          <Text style={styles.label}>{label}</Text>
          <H>{term.title}</H>
          {term.text.map((x, i) => <P key={i}>{x}</P>)}
          {term.list && (
            <>
              <Text style={styles.label}>{term.list.label}</Text>
              <P>{term.list.items.join(', ')}</P>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: space.s },
});
