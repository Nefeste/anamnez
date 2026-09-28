// Перенос на другой телефон (FR-SYS-7, 07-data-model.md §4): сохранить прогресс в файл или
// открыть файл с другого телефона. Перед заменой — что в файле. Сеть не нужна: файл пишет и
// читает системное окно выбора (src/state/storage.ts).
import { useState } from 'react';
import { T } from '@/i18n';
import { VERSION } from '@/info';
import { rawStore, readPickedFile, writePickedFile } from '@/state/storage';
import { openTransfer, parseTransfer, saveTransfer, type TransferFile, transferLines, transferName } from '@/state/transfer';
import { Button, Card, H, P, Screen, Sheet } from '@/ui/components';

export default function TransferScreen() {
  const t = T.transfer;
  const [note, setNote] = useState<string>();
  const [file, setFile] = useState<TransferFile>();
  const [busy, setBusy] = useState(false);

  const run = async (job: () => Promise<void>, failed: string) => {
    setBusy(true);
    setNote(undefined);
    try {
      await job();
    } catch {
      setNote(failed);
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(async () => {
    const name = await writePickedFile(transferName(new Date()), await saveTransfer(rawStore, VERSION));
    if (name) setNote(t.saved(name));
  }, t.saveFailed);
  const open = () => run(async () => {
    const text = await readPickedFile();
    if (text === null) return;
    const r = parseTransfer(text);
    if (r.ok) setFile(r.file);
    else setNote(t.problem[r.problem]);
  }, t.openFailed);
  const replace = () => {
    const f = file;
    setFile(undefined);
    if (f) run(async () => {
      await openTransfer(rawStore, f);
      setNote(t.done);
    }, t.openFailed);
  };

  return (
    <Screen>
      <Card>
        <P>{t.intro}</P>
      </Card>
      <Button testID="transfer-save" title={t.save} hint={t.saveHint} disabled={busy} onPress={save} />
      <Button testID="transfer-open" kind="plain" title={t.open} hint={t.openHint} disabled={busy} onPress={open} />
      {note ? <P testID="transfer-note">{note}</P> : null}
      <Sheet visible={!!file} onClose={() => setFile(undefined)} closeTitle={t.cancel} testID="transfer-sheet">
        {file && (
          <>
            <H>{t.confirmTitle}</H>
            <P muted>{t.confirmText}</P>
            {transferLines(file).map((line, i) => (
              <P key={line} testID={`transfer-line-${i}`}>{line}</P>
            ))}
            <Button testID="transfer-replace" title={t.replace} onPress={replace} />
          </>
        )}
      </Sheet>
    </Screen>
  );
}
