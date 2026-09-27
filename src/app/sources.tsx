// Источники медицинской базы (11-publishing.md §3, «Об игре»): по видам, без повторов.
import { db } from '@/content';
import { T } from '@/i18n';
import { sourceGroups } from '@/state/sources';
import { Card, H, P, Screen } from '@/ui/components';

export default function Sources() {
  const t = T.about;
  return (
    <Screen>
      <Card>
        <P>{t.sourcesIntro}</P>
      </Card>
      {sourceGroups(db).map(g => (
        <Card key={g.kind}>
          <H>{t.kinds[g.kind]}</H>
          {g.items.map(line => <P key={line} testID="source">{line}</P>)}
        </Card>
      ))}
    </Screen>
  );
}
