// Смена · приём нанятого врача (spec 2026-09-hired-doctors, часть 19): карта пациента только для
// чтения — что врач уже узнал; «Забрать себе» — пациент со всем этим переходит к вам.
import { router } from 'expo-router';
import { useEffect } from 'react';
import { T } from '@/i18n';
import { leaveCase, takeOver, useShift, useShiftCase } from '@/state/session';
import { NoPatient } from '@/ui/case/NoPatient';
import { PatientCard } from '@/ui/case/PatientCard';
import { shiftActions, toShift } from '@/ui/case/shift';

export default function ColleagueCase() {
  const v = useShiftCase();
  const shift = useShift();
  // ушли с экрана — карта снова ваша: иначе «Продолжить приём» открыл бы пациента врача
  useEffect(() => leaveCase, []);
  if (!v?.colleague) return <NoPatient />;
  const t = T.shift.colleagueCase;
  const id = v.colleague.id;
  const take = () => {
    // вы свободны — он у вас в кабинете, карта ваша; заняты — он первым в вашей очереди
    if (takeOver(id)) router.replace('/shift/patient');
    else toShift();
  };
  return (
    <PatientCard
      view={v}
      actions={shiftActions}
      readOnly={{
        note: t.note(v.colleague.doctor),
        footer: { title: `${t.take} ▶`, hint: t.takeHint(v.colleague.away ? 'away' : shift.inRoom ? 'busy' : 'free'), testID: 'colleague-take', run: take },
      }}
    />
  );
}
