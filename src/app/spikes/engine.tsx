// П3 · Детерминизм между движками: отпечаток тысячи пациентов здесь (Hermes на телефоне,
// V8 в браузере) должен совпасть с тем, что записал тест в Bun.
import { useState } from 'react';
import golden from '../../../tools/test/fixtures/golden.json';
import { db } from '@/content';
import { goldenRun } from '@/engine/med/golden';
import { T } from '@/i18n';
import { Button, Card, H, P, Screen } from '@/ui/components';

export default function EngineSpike() {
  const [result, setResult] = useState<{ hash: string; ms: number; primaries: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    setTimeout(() => {
      const t0 = Date.now();
      const r = goldenRun(db, 1000);
      setResult({ ...r, ms: Date.now() - t0 });
      setBusy(false);
    }, 30);
  };
  const same = result?.hash === golden.hash;
  return (
    <Screen>
      <P muted>{T.spikes.engine.content(db.contentVersion, db.hash)}</P>
      <Button testID="engine-run" title={busy ? T.spikes.engine.running : T.spikes.engine.run} onPress={run} disabled={busy} />
      {result && (
        <Card>
          <H>{T.spikes.engine.hash}</H>
          <P testID="engine-hash">{result.hash}</P>
          <P testID="engine-verdict">{`${T.spikes.engine.expected}: ${golden.hash} — ${same ? T.spikes.engine.same : T.spikes.engine.differs}`}</P>
          <P muted>{T.spikes.engine.time(result.ms)}</P>
          <H>{T.spikes.engine.mix}</H>
          {Object.entries(result.primaries).map(([id, n]) => (
            <P key={id}>{`${db.conditions[id]?.name.ru ?? id}: ${n}`}</P>
          ))}
        </Card>
      )}
    </Screen>
  );
}
