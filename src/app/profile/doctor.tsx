// Имя и пол врача — поменять из профиля (при первом запуске та же форма — в меню).
import { router } from 'expo-router';
import { T } from '@/i18n';
import { setDoctor, useProfile } from '@/state/profile';
import { DoctorForm } from '@/ui/profile';

export default function DoctorScreen() {
  const p = useProfile();
  return (
    <DoctorForm
      initial={p.doctor}
      submitTitle={T.profile.save}
      onSubmit={d => {
        setDoctor(d);
        router.back();
      }}
    />
  );
}
