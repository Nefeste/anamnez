// Корень: стек Expo Router (ADR 0003) внутри корня жестов. Здесь же смене и настройкам
// даётся хранилище платформы, и смена сохраняется, когда приложение уходит в фон.
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { T } from '@/i18n';
import { saveNow, setStore } from '@/state/session';
import { loadSettings, setSettingsStore } from '@/state/settings';
import { rawStore } from '@/state/storage';
import { colors } from '@/ui/theme';

setStore(rawStore);
setSettingsStore(rawStore);
// громкость и вибрация нужны и тому, кто пришёл не через меню
loadSettings();

export default function RootLayout() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') saveNow();
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.card },
            headerTintColor: colors.ink,
            contentStyle: { backgroundColor: colors.bg },
            headerBackTitle: T.common.back,
          }}>
          <Stack.Screen name="index" options={{ title: T.common.appName }} />
          <Stack.Screen name="settings" options={{ title: T.settings.title }} />
          <Stack.Screen name="about" options={{ title: T.about.title }} />
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
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
