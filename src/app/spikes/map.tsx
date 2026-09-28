// П2 · Карта больницы на Skia: кадры в секунду и худший кадр видны сверху.
import { useMemo, useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import { spikeHospital } from '@/engine/hospital/grid';
import { T } from '@/i18n';
import { type FrameStats, HospitalMap } from '@/render/map/HospitalMap';
import { Button } from '@/ui/components';
import { makeStyles, space } from '@/ui/theme';

export default function MapSpike() {
  const styles = useStyles();
  const { width, height } = useWindowDimensions();
  const layout = useMemo(() => spikeHospital(1), []);
  const [stats, setStats] = useState<FrameStats>({ fps: 0, worstMs: 0 });
  const [paused, setPaused] = useState(false);
  const [picked, setPicked] = useState(T.spikes.map.tapHint);
  const onCell = (x: number, y: number) => {
    const room = layout.rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    const name = room ? T.spikes.roomNames[room.type] : T.spikes.roomNames.corridor;
    setPicked(T.spikes.map.room(name, x, y));
  };
  return (
    <View style={styles.fill}>
      <View style={styles.bar}>
        <Text testID="map-fps" style={styles.stat}>{`${T.spikes.map.fps(stats.fps)} · ${T.spikes.map.worst(stats.worstMs)}`}</Text>
        <Text style={styles.muted}>{T.spikes.map.stats(layout.objects.length, 60)}</Text>
        <Text testID="map-picked" style={styles.muted}>{picked}</Text>
      </View>
      <HospitalMap layout={layout} width={width} height={height - 190} paused={paused} onCell={onCell} onStats={setStats} />
      <View style={styles.bottom}>
        <Button kind="plain" title={paused ? T.spikes.map.play : T.spikes.map.pause} onPress={() => setPaused(p => !p)} />
      </View>
    </View>
  );
}

const useStyles = makeStyles(t => ({
  fill: { flex: 1, backgroundColor: t.colors.bg },
  bar: { padding: space.m, gap: 2, backgroundColor: t.colors.card, borderBottomWidth: 1, borderColor: t.colors.line },
  stat: { fontSize: 16, fontWeight: '700', color: t.colors.ink },
  muted: { fontSize: 13, color: t.colors.muted },
  bottom: { padding: space.m },
}));
