// «Что это?» — справка простыми словами поверх экрана (03-game-design.md §5): общая для
// приёма и решения. Справка — короткая выжимка статьи энциклопедии; «Подробнее» ведёт в
// полную статью (§11), «назад» из неё — обратно на экран.
import { Text } from './text';
import { T } from '@/i18n';
import { Button, H, P, Sheet } from './components';
import { openArticle } from './encyclopedia';
import { makeStyles, space } from './theme';

export interface Term {
  /** статья энциклопедии */
  id?: string;
  title: string;
  text: string[];
  list?: { label: string; items: string[] };
}

export function TermSheet({ term, onClose, label, closeTitle }: { term: Term | null; onClose: () => void; label: string; closeTitle: string }) {
  const styles = useStyles();
  const more = term?.id;
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
          {more ? (
            <Button
              testID="term-sheet-more"
              kind="plain"
              title={T.encyclopedia.more}
              onPress={() => {
                onClose();
                openArticle(more);
              }}
            />
          ) : null}
        </>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
}));
