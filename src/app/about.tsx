// «Об игре» (12-publishing.md §3, 09-game-design.md §12): версия и что нового, полная
// медицинская оговорка, медицинская база и её источники, лицензии открытых компонентов (с 0.5.6),
// разработчик и письмо ему, данные и политика конфиденциальности; семь касаний строки версии включают режим
// разработчика (0.6.3). Ссылки открываются в браузере и почте телефона: у самой игры доступа в интернет нет.
// Студия — по брендбуку (ADR 0017): знак, строка «Игра студии „Горница“», сайт и почта, внизу — полоса-рушник.
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { db } from '@/content';
import { T } from '@/i18n';
import { PRIVACY_URL, SITE_URL, SUPPORT_EMAIL, VERSION } from '@/info';
import { licenseCount } from '@/licenses';
import { Rushnik, StudioMark } from '@/render/Studio';
import { updateSettings, useSettings } from '@/state/settings';
import { sourceGroups } from '@/state/sources';
import { Button, Card, H, P, Screen } from '@/ui/components';
import { device } from '@/ui/device';
import { makeStyles, space, useTheme } from '@/ui/theme';

const noScheme = (url: string) => url.replace(/^https?:\/\//, '');
/** Касаний строки версии до режима разработчика — как в Android; сколько ещё — с третьего. */
const DEV_TAPS = 7;
const DEV_HINT_FROM = 3;

export default function About() {
  const t = T.about;
  const styles = useStyles();
  const dark = useTheme().name === 'dark';
  const version = VERSION;
  const [failed, setFailed] = useState<string | null>(null);
  const [before, setBefore] = useState(false);
  // ширина полосы-рушника — по ширине листа, когда он разложен
  const [band, setBand] = useState(0);
  const open = (url: string, shown: string) => {
    setFailed(null);
    Linking.openURL(url).catch(() => setFailed(shown));
  };
  const mail = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(t.mailSubject(version))}&body=${encodeURIComponent(t.mailBody(version, device()))}`;
  // режим разработчика (0.6.3): «Проверки на телефоне» в настройках — только в нём
  const dev = useSettings().devMode;
  const [taps, setTaps] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const tapVersion = () => {
    const n = taps + 1;
    setTaps(n);
    if (!dev && n >= DEV_TAPS) {
      setEnabled(true);
      updateSettings({ devMode: true });
    }
  };
  const devNote = enabled ? t.devOn : dev ? (taps > 0 ? t.devAlready : null) : taps >= DEV_HINT_FROM ? t.devTaps(DEV_TAPS - taps) : null;
  const sources = sourceGroups(db).reduce((n, g) => n + g.items.length, 0);
  const count = (table: object) => Object.keys(table).length;

  return (
    <Screen>
      <Card>
        <H>{T.common.appName}</H>
        <Pressable onPress={tapVersion} hitSlop={space.s}>
          <P testID="about-version">{t.version(version)}</P>
        </Pressable>
        {devNote ? <P muted testID="about-dev">{devNote}</P> : null}
        <P muted>{t.tagline}</P>
      </Card>
      <Card testID="about-news">
        <H>{t.whatsNew}</H>
        {t.news.map(line => <P key={line}>{`• ${line}`}</P>)}
        {/* прежние версии — под кнопкой (1.1.7, просьба владельца 01.11.2026): новые сверху, с первого выпуска */}
        <Button testID="about-news-before" kind="plain" title={before ? t.newsBeforeClose : t.newsBeforeOpen} onPress={() => setBefore(!before)} />
        {before && t.newsBefore.map(v => (
          <View key={v.version} testID={`about-news-${v.version}`} style={styles.before}>
            <Text style={styles.beforeTitle}>{t.newsVersion(v.version, v.title)}</Text>
            {v.items.map(line => <P key={line} muted>{`• ${line}`}</P>)}
          </View>
        ))}
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
        <H>{t.soundTitle}</H>
        <P testID="about-sound">{t.sound}</P>
      </Card>
      <Card>
        <H>{t.openTitle}</H>
        <P>{t.open}</P>
        <Button testID="about-licenses" kind="plain" title={t.licenses(licenseCount)} onPress={() => router.push('/licenses')} />
      </Card>
      <Card>
        <H>{t.developerTitle}</H>
        <View testID="about-studio" style={styles.studio} accessible accessibilityLabel={t.studio}>
          <StudioMark size={44} dark={dark} />
          <View style={styles.studioText}><P>{t.studio}</P></View>
        </View>
        <Button testID="about-write" title={t.write} hint={SUPPORT_EMAIL} onPress={() => open(mail, SUPPORT_EMAIL)} />
        <Button testID="about-site" kind="plain" title={t.site} hint={noScheme(SITE_URL)} onPress={() => open(SITE_URL, noScheme(SITE_URL))} />
        {failed ? <P testID="about-failed">{t.cantOpen(failed)}</P> : null}
      </Card>
      <Card>
        <H>{t.dataTitle}</H>
        <P>{t.data}</P>
        <Button testID="about-privacy" kind="plain" title={t.privacy} hint={noScheme(PRIVACY_URL)} onPress={() => open(PRIVACY_URL, noScheme(PRIVACY_URL))} />
      </Card>
      <View testID="about-rushnik" style={styles.band} onLayout={e => setBand(Math.floor(e.nativeEvent.layout.width))}>
        {band > 0 ? <Rushnik width={band} dark={dark} /> : null}
      </View>
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  studio: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  before: { gap: space.xs },
  beforeTitle: { fontFamily: t.fonts.title, fontSize: 16, lineHeight: 21, fontWeight: '700', color: t.colors.ink },
  studioText: { flex: 1 },
  // рушник — на бумаге между двумя тонкими линиями (брендбук студии, «Орнамент и канва»)
  band: { backgroundColor: t.colors.card, borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.colors.line, paddingVertical: 10 },
}));
