// Модель телефона и версия Android — в письмо разработчику и в отчёт об ошибке: чтобы было с
// чем искать ошибку. Игрок видит этот текст и может его стереть.
import { Platform } from 'react-native';

export function device(): string {
  if (Platform.OS === 'android') {
    const c = Platform.constants;
    return `${c.Manufacturer} ${c.Model}, Android ${c.Release}`;
  }
  return Platform.OS;
}
