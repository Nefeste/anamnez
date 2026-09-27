// Энциклопедия (03-game-design.md §11): оглавление и поиск по всей базе игры. Вверху —
// оговорка одной строкой (11-publishing.md §3).
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { db } from '@/content';
import { T } from '@/i18n';
import { search, sectionsOf } from '@/state/encyclopedia';
import { Card, P, Screen } from '@/ui/components';
import { EncyclopediaNote, ListRow, openArticle } from '@/ui/encyclopedia';
import { colors, radius, space, touch } from '@/ui/theme';

export default function EncyclopediaScreen() {
  const t = T.encyclopedia;
  const [query, setQuery] = useState('');
  const found = query.trim() ? search(db, query) : null;
  return (
    <Screen>
      <EncyclopediaNote />
      <TextInput
        testID="enc-search"
        value={query}
        onChangeText={setQuery}
        placeholder={t.search}
        placeholderTextColor={colors.muted}
        autoCorrect={false}
        returnKeyType="search"
        style={styles.search}
      />
      <Card>
        {found === null
          ? sectionsOf(db).map(s => (
            <ListRow
              key={s.section}
              testID={`enc-section-${s.section}`}
              title={s.title}
              hint={t.articles(s.count)}
              onPress={() => router.push({ pathname: '/encyclopedia/[section]', params: { section: s.section } })}
            />
          ))
          : found.length === 0
            ? <P muted>{t.nothing}</P>
            : found.map(r => <ListRow key={r.id} testID={`enc-item-${r.id}`} title={r.title} hint={t.sections[r.section]} onPress={() => openArticle(r.id)} />)}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    minHeight: touch,
    backgroundColor: colors.card,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.l,
    fontSize: 16,
    color: colors.ink,
  },
});
