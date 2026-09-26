// В кабинете никого (приём закончен или пациент отпущен ждать результатов) — назад к смене.
import { T } from '@/i18n';
import { Button, Card, P, Screen } from '@/ui/components';
import { shiftBack } from './shift';

export function NoPatient() {
  const back = shiftBack();
  return (
    <Screen footer={<Button testID={back.testID} title={back.title} onPress={back.run} />}>
      <Card>
        <P muted>{T.shift.noPatient}</P>
      </Card>
    </Screen>
  );
}
