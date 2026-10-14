// Лицензии открытых компонентов (spec 2026-10-licenses, 0.5.6; 11-publishing.md §8): шрифты, код JS и библиотеки
// Android, которые попали в сборку, с правообладателями и полными текстами лицензий — их условия требуют приложить
// тексты к выпущенной игре. Строка раскрывается касанием; список собирает `tools/licenses/build.ts`.
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { T } from '@/i18n';
import { LICENSES as licenses } from '@/licenses';
import type { LicenseItem } from '@/licenses/types';
import { Card, H, P, Screen } from '@/ui/components';
import { makeStyles, space } from '@/ui/theme';

function Row({ item, id, open, onToggle }: { item: LicenseItem; id: string; open: boolean; onToggle: () => void }) {
  const t = T.about;
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Pressable testID={`license-${id}`} accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle} style={({ pressed }) => [styles.head, pressed && styles.pressed]}>
        <Text style={styles.name}>{item.version ? t.licenseName(item.name, item.version) : item.name}</Text>
        <Text style={styles.meta}>{item.via ? t.licenseVia(item.license, item.via) : item.license}</Text>
        <Text style={styles.meta}>{item.holder}</Text>
      </Pressable>
      {open ? item.texts.map(key => <Text key={key} testID={`license-${id}-text`} style={styles.text}>{licenses.texts[key]}</Text>) : null}
    </View>
  );
}

export default function LicensesScreen() {
  const t = T.about;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Screen>
      <Card>
        <P>{t.licensesIntro}</P>
      </Card>
      {licenses.groups.map(g => (
        <Card key={g.key} testID={`licenses-${g.key}`}>
          <H>{t.licenseGroups[g.key]}</H>
          {g.items.map((item, i) => {
            const id = `${g.key}-${i}`;
            return <Row key={id} id={id} item={item} open={open === id} onToggle={() => setOpen(open === id ? null : id)} />;
          })}
        </Card>
      ))}
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  row: { borderTopWidth: 1, borderColor: t.colors.line, paddingVertical: space.s },
  head: { gap: 2 },
  pressed: { opacity: 0.7 },
  name: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: t.colors.ink },
  meta: { fontSize: 13, lineHeight: 18, color: t.colors.muted },
  text: { fontFamily: t.fonts.mono, fontSize: 11, lineHeight: 15, color: t.colors.ink, marginTop: space.s },
}));
