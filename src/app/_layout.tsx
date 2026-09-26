// Корень: стек Expo Router (ADR 0003) внутри корня жестов.
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { T } from '@/i18n';
import { colors } from '@/ui/theme';

export default function RootLayout() {
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
          <Stack.Screen name="spikes/engine" options={{ title: T.spikes.engine.title }} />
          <Stack.Screen name="spikes/map" options={{ title: T.spikes.map.title, gestureEnabled: false }} />
          <Stack.Screen name="spikes/patient" options={{ title: T.spikes.patient.title }} />
          <Stack.Screen name="spikes/imaging" options={{ title: T.spikes.imaging.title }} />
          <Stack.Screen name="spikes/save" options={{ title: T.spikes.save.title }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
