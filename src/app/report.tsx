// «Сообщить об ошибке» (06-architecture.md §8): игрок описывает, что случилось, видит весь
// текст — версия игры и базы, телефон, последние сбои, зерно и журнал дня — и отправляет
// его сам через «Поделиться». Смена на это время стоит: её экран не на виду.
import { useState } from 'react';
import { Share } from 'react-native';
import { db } from '@/content';
import { T } from '@/i18n';
import { BUILD, SUPPORT_EMAIL, VERSION } from '@/info';
import { recentErrors } from '@/state/errors';
import { buildReport } from '@/state/report';
import { shiftState, useShift } from '@/state/session';
import { Button, Card, P, Screen } from '@/ui/components';
import { device } from '@/ui/device';
import { Text, TextInput } from '@/ui/text';
import { makeStyles, space, touch } from '@/ui/theme';

export default function ReportScreen() {
  const styles = useStyles();
  const t = T.report;
  const shift = useShift();
  const [description, setDescription] = useState('');
  const [failed, setFailed] = useState(false);
  // смена на этом экране стоит, поэтому живое состояние не устареет, пока его читаем
  const text = buildReport({ description, version: VERSION, build: BUILD, device: device(), db, shift: shiftState(), clock: shift.clock, errors: recentErrors() });
  const share = () => {
    setFailed(false);
    Share.share({ title: t.shareTitle, message: text }, { dialogTitle: t.shareTitle, subject: t.shareTitle }).catch(() => setFailed(true));
  };
  return (
    <Screen footer={<Button testID="report-share" title={t.share} onPress={share} />}>
      <Card>
        <P>{t.intro(SUPPORT_EMAIL)}</P>
        <Text style={styles.label}>{t.describe}</Text>
        <TextInput
          testID="report-description"
          value={description}
          onChangeText={setDescription}
          placeholder={t.placeholder}
          multiline
          style={styles.input}
        />
        {failed ? <P>{t.cantShare(SUPPORT_EMAIL)}</P> : null}
      </Card>
      <Card>
        <Text testID="report-text" selectable style={styles.text}>{text}</Text>
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
  input: { minHeight: touch * 2, backgroundColor: t.colors.bg, borderRadius: t.shape.radius, borderWidth: 1, borderColor: t.colors.line, padding: space.m, fontSize: 16, color: t.colors.ink, textAlignVertical: 'top' },
  text: { fontSize: 13, lineHeight: 18, color: t.colors.ink, fontFamily: 'monospace' },
}));
