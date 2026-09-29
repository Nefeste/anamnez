// П7 · Рентген костей кодом (spec 2026-09-chapter-2, часть 31): у каждого вида — норма и переломы;
// подпись — что нарисовано. Рисунков на экране больше 16 — все `still`, как на экране снимков.
import { useWindowDimensions, View } from 'react-native';
import { T } from '@/i18n';
import { XrayBone } from '@/render/XrayBone';
import type { BoneView } from '@/render/xray/boneGeometry';
import { BONE_CASES } from '@/state/imagingCases';
import { Card, H, P, Screen } from '@/ui/components';

const VIEWS: BoneView[] = ['wrist', 'ankle', 'foot', 'hip', 'clavicle', 'ribs'];

export default function BonesSpike() {
  const { width } = useWindowDimensions();
  const w = Math.min(width, 640) - 64;
  const t = T.spikes.bones;
  return (
    <Screen>
      {VIEWS.map(view => (
        <Card key={view} testID={`bones-${view}`}>
          <H>{t.views[view]}</H>
          {BONE_CASES.filter(k => k.findings.view === view).map(k => (
            <View key={k.key} testID={k.key} style={{ gap: 4 }}>
              <XrayBone width={w} findings={k.findings} seed={k.seed} still />
              <P muted>{k.label}</P>
            </View>
          ))}
        </Card>
      ))}
      <Card>
        <P muted>{t.note}</P>
      </Card>
    </Screen>
  );
}
