// «Об игре» (11-publishing.md §3, 03-game-design.md §12): версия и что нового, полная
// медицинская оговорка, медицинская база и её источники, разработчик и письмо ему, данные и
// политика конфиденциальности. Ссылки открываются в браузере и почте телефона: у самой игры
// доступа в интернет нет.
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import { db } from '@/content';
import { T } from '@/i18n';
import { PRIVACY_URL, SITE_URL, SUPPORT_EMAIL, VERSION } from '@/info';
import { sourceGroups } from '@/state/sources';
import { Button, Card, H, P, Screen } from '@/ui/components';
import { device } from '@/ui/device';

const noScheme = (url: string) => url.replace(/^https?:\/\//, '');

export default function About() {
  const t = T.about;
  const version = VERSION;
  const [failed, setFailed] = useState<string | null>(null);
  const open = (url: string, shown: string) => {
    setFailed(null);
    Linking.openURL(url).catch(() => setFailed(shown));
  };
  const mail = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(t.mailSubject(version))}&body=${encodeURIComponent(t.mailBody(version, device()))}`;
  const sources = sourceGroups(db).reduce((n, g) => n + g.items.length, 0);
  const count = (table: object) => Object.keys(table).length;

  return (
    <Screen>
      <Card>
        <H>{T.common.appName}</H>
        <P testID="about-version">{t.version(version)}</P>
        <P muted>{t.tagline}</P>
      </Card>
      <Card>
        <H>{t.whatsNew}</H>
        {t.news.map(line => <P key={line}>{`• ${line}`}</P>)}
      </Card>
      <Card>
        <H>{T.common.disclaimerTitle}</H>
        <P testID="about-disclaimer">{T.common.disclaimer}</P>
      </Card>
      <Card>
        <H>{t.baseTitle}</H>
        <P>{t.base(db.contentVersion, count(db.conditions), count(db.findings), count(db.exams), count(db.treatments))}</P>
        <P muted>{t.baseDraft}</P>
        <Button testID="about-sources" kind="plain" title={t.sources(sources)} onPress={() => router.push('/sources')} />
      </Card>
      <Card>
        <H>{t.developerTitle}</H>
        <P>{t.developer}</P>
        <Button testID="about-write" title={t.write} hint={SUPPORT_EMAIL} onPress={() => open(mail, SUPPORT_EMAIL)} />
        <Button testID="about-site" kind="plain" title={t.site} hint={noScheme(SITE_URL)} onPress={() => open(SITE_URL, noScheme(SITE_URL))} />
        {failed ? <P testID="about-failed">{t.cantOpen(failed)}</P> : null}
      </Card>
      <Card>
        <H>{t.dataTitle}</H>
        <P>{t.data}</P>
        <Button testID="about-privacy" kind="plain" title={t.privacy} hint={noScheme(PRIVACY_URL)} onPress={() => open(PRIVACY_URL, noScheme(PRIVACY_URL))} />
      </Card>
    </Screen>
  );
}
