// Корень: стек Expo Router (ADR 0003) внутри корня жестов. Здесь же смене, настройкам и
// профилю даётся хранилище платформы, и смена сохраняется, когда приложение уходит в фон.
// Шапка, строка состояния и фон окна — по теме (spec 2026-09-own-look).
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { T } from '@/i18n';
import { installErrorLog } from '@/state/errors';
import { loadProfile, setProfileStore } from '@/state/profile';
import { saveNow, setStore } from '@/state/session';
import { loadSettings, setSettingsStore } from '@/state/settings';
import { rawStore } from '@/state/storage';
import { installFonts } from '@/ui/fonts';
import { useTheme } from '@/ui/theme';

setStore(rawStore);
setSettingsStore(rawStore);
setProfileStore(rawStore);
// сбои — в журнал для «Сообщить об ошибке»; только на телефоне
void installErrorLog(rawStore);
// громкость и вибрация нужны и тому, кто пришёл не через меню; профиль — чтобы записывать приёмы
loadSettings();
loadProfile();
// веб: шрифты из сборки правилами @font-face; на телефоне они встроены плагином expo-font
installFonts();

export default function RootLayout() {
  const t = useTheme();
  // фон окна — под экраном при переходах и за клавиатурой
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(t.colors.bg).catch(() => undefined);
  }, [t]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') saveNow();
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style={t.name === 'dark' ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.colors.card },
            headerTintColor: t.colors.ink,
            headerTitleStyle: { fontFamily: t.fonts.title, fontWeight: '700' },
            // черту под шапкой рисует экран: двойную в «Медкарте», тонкую в «Мониторе»
            headerShadowVisible: false,
            contentStyle: { backgroundColor: t.colors.bg },
            headerBackTitle: T.common.back,
          }}>
          <Stack.Screen name="index" options={{ title: T.common.appName }} />
          <Stack.Screen name="settings" options={{ title: T.settings.title }} />
          <Stack.Screen name="about" options={{ title: T.about.title }} />
          <Stack.Screen name="report" options={{ title: T.report.title }} />
          <Stack.Screen name="transfer" options={{ title: T.transfer.title }} />
          <Stack.Screen name="sources" options={{ title: T.about.sourcesTitle }} />
          <Stack.Screen name="encyclopedia/index" options={{ title: T.encyclopedia.title }} />
          <Stack.Screen name="encyclopedia/[section]" options={{ title: T.encyclopedia.title }} />
          <Stack.Screen name="encyclopedia/article/[id]" options={{ title: T.encyclopedia.title }} />
          <Stack.Screen name="spikes/engine" options={{ title: T.spikes.engine.title }} />
          <Stack.Screen name="spikes/map" options={{ title: T.spikes.map.title, gestureEnabled: false }} />
          <Stack.Screen name="spikes/patient" options={{ title: T.spikes.patient.title }} />
          <Stack.Screen name="spikes/decision" options={{ title: T.spikes.decision.title }} />
          <Stack.Screen name="spikes/outcome" options={{ title: T.spikes.decision.outcomeTitle }} />
          <Stack.Screen name="spikes/imaging" options={{ title: T.spikes.imaging.title }} />
          <Stack.Screen name="spikes/save" options={{ title: T.spikes.save.title }} />
          <Stack.Screen name="shift/index" options={{ title: T.shift.title }} />
          <Stack.Screen name="shift/patient" options={{ title: T.spikes.patient.title }} />
          <Stack.Screen name="shift/decision" options={{ title: T.spikes.decision.title }} />
          <Stack.Screen name="shift/outcome" options={{ title: T.spikes.decision.outcomeTitle }} />
          <Stack.Screen name="shift/colleague" options={{ title: T.spikes.patient.title }} />
          <Stack.Screen name="sandbox/build" options={{ title: T.sandbox.build, gestureEnabled: false }} />
          <Stack.Screen name="sandbox/new" options={{ title: T.sandbox.title }} />
          <Stack.Screen name="sandbox/staff" options={{ title: T.sandbox.staffTitle }} />
          <Stack.Screen name="campaign/index" options={{ title: T.campaign.title }} />
          <Stack.Screen name="quick" options={{ title: T.campaign.quick }} />
          <Stack.Screen name="single" options={{ title: T.single.title }} />
          <Stack.Screen name="daily/index" options={{ title: T.daily.title }} />
          <Stack.Screen name="daily/patient" options={{ title: T.spikes.patient.title }} />
          <Stack.Screen name="daily/decision" options={{ title: T.spikes.decision.title }} />
          <Stack.Screen name="daily/outcome" options={{ title: T.spikes.decision.outcomeTitle }} />
          <Stack.Screen name="profile/index" options={{ title: T.profile.title }} />
          <Stack.Screen name="profile/doctor" options={{ title: T.profile.editTitle }} />
          <Stack.Screen name="profile/achievements" options={{ title: T.profile.achievements }} />
          <Stack.Screen name="profile/case/[key]" options={{ title: T.spikes.decision.outcomeTitle }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
