// Песочница заново (spec 2026-09-own-hospital): те же выбор участка, бюджета и сложности, что
// при первом начале; прежняя больница стирается, только когда нажали «Начать».
import { router } from 'expo-router';
import { startSandbox } from '@/state/session';
import { NewSandbox } from '@/ui/sandbox';

export default function SandboxNew() {
  return (
    <NewSandbox
      onStart={opts => {
        startSandbox(opts);
        router.replace('/shift');
      }}
    />
  );
}
