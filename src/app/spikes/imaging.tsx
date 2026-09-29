// П5 · Снимки, ЭКГ и портреты кодом; КТ и МРТ головы — с 0.0.34, УЗИ — с 0.0.35
// (spec 2026-09-ct-mri-ultrasound), обзорный снимок живота — с 0.0.49, снимок груди при травме —
// с 0.2.0 (spec 2026-09-chapter-2).
// Рисунков на экране больше 16 — все `still`: в вебе холст с живым контекстом WebGL их не вместит.
import { useWindowDimensions, View } from 'react-native';
import { T } from '@/i18n';
import { Ecg } from '@/render/Ecg';
import { HeadSlice } from '@/render/HeadSlice';
import { Portrait } from '@/render/Portrait';
import { UsSector } from '@/render/UsSector';
import { Xray } from '@/render/Xray';
import { XrayAbdomen } from '@/render/XrayAbdomen';
import { ABDOMEN_CASES, CHEST_CASES, HEAD_CASES, US_CASES } from '@/state/imagingCases';
import { Card, H, P, Screen } from '@/ui/components';

const PEOPLE: { seed: number; sex: 'm' | 'f'; age: number }[] = [
  { seed: 1, sex: 'm', age: 67 }, { seed: 2, sex: 'f', age: 34 }, { seed: 3, sex: 'm', age: 22 }, { seed: 4, sex: 'f', age: 71 },
  { seed: 5, sex: 'm', age: 45 }, { seed: 6, sex: 'f', age: 58 }, { seed: 7, sex: 'm', age: 81 }, { seed: 8, sex: 'f', age: 19 },
  { seed: 9, sex: 'm', age: 52 }, { seed: 10, sex: 'f', age: 40 },
];

export default function ImagingSpike() {
  const { width } = useWindowDimensions();
  const w = Math.min(width, 640) - 64;
  const half = (w - 12) / 2;
  return (
    <Screen>
      <Card>
        <H>{T.spikes.imaging.xrayNormal}</H>
        <Xray width={w} seed={1} still />
        <P muted>{T.spikes.imaging.sideNote}</P>
      </Card>
      <Card>
        <H>{`${T.spikes.imaging.xrayRight} · ${T.spikes.imaging.xrayLeft}`}</H>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Xray width={half} seed={2} findings={{ infiltrate: { side: 'right', density: 0.8 } }} still />
          <Xray width={half} seed={3} findings={{ infiltrate: { side: 'left', density: 0.5 } }} still />
        </View>
      </Card>
      <Card testID="chest">
        <H>{T.spikes.imaging.chest.title}</H>
        {CHEST_CASES.map(k => (
          <View key={k.key} testID={k.key} style={{ gap: 4 }}>
            <Xray width={w} findings={k.findings} seed={k.seed} still />
            <P muted>{k.label}</P>
          </View>
        ))}
        <P muted>{T.spikes.imaging.chest.note}</P>
      </Card>
      <Card testID="abdomen">
        <H>{T.spikes.imaging.abdomen.title}</H>
        {ABDOMEN_CASES.map(k => (
          <View key={k.key} testID={k.key} style={{ gap: 4 }}>
            <XrayAbdomen width={w} findings={k.findings} seed={k.seed} still />
            <P muted>{k.label}</P>
          </View>
        ))}
        <P muted>{T.spikes.imaging.abdomen.note}</P>
      </Card>
      {(['ct', 'mri'] as const).map(mode => (
        <Card key={mode} testID={`head-${mode}`}>
          <H>{mode === 'ct' ? T.spikes.imaging.head.ctTitle : T.spikes.imaging.head.mriTitle}</H>
          {HEAD_CASES.filter(k => k.mode === mode).map(k => (
            <View key={k.key} testID={`head-${k.key}`} style={{ gap: 4 }}>
              <HeadSlice width={w} findings={k.findings} seed={k.seed} mode={k.mode} still />
              <P muted>{k.label}</P>
            </View>
          ))}
          <P muted>{T.spikes.imaging.head.note}</P>
        </Card>
      ))}
      <Card testID="us">
        <H>{T.spikes.imaging.us.title}</H>
        {US_CASES.map(k => (
          <View key={k.key} testID={k.key} style={{ gap: 4 }}>
            <UsSector width={w} findings={k.findings} seed={k.seed} still />
            <P muted>{k.label}</P>
          </View>
        ))}
        <P muted>{T.spikes.imaging.us.note}</P>
      </Card>
      <Card>
        <H>{T.spikes.imaging.ecgSinus}</H>
        <Ecg width={w} spec={{ rhythm: 'sinus', rate: 72, seconds: 10, seed: 1 }} still />
        <H>{T.spikes.imaging.ecgAf}</H>
        <Ecg width={w} spec={{ rhythm: 'af', rate: 110, seconds: 10, seed: 2 }} still />
      </Card>
      <Card>
        <H>{T.spikes.imaging.portraits}</H>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {PEOPLE.map(p => <Portrait key={p.seed} seed={p.seed} sex={p.sex} age={p.age} size={64} still />)}
        </View>
      </Card>
    </Screen>
  );
}
