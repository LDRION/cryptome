/**
 * The rule that decides whether the plan works, kept apart so that it can be tested and cannot
 * quietly change. The replay won about 7 of 10 trades that reached a self-built block, so a real
 * result far below that means the model is wrong even if the mechanism works.
 */

export const SHOTS_NEEDED = 10;
/** At the replay's rate, fewer wins than this in ten would happen less than once in a hundred. */
export const WINS_FOR_MODEL = 4;

export type Verdict = 'running' | 'stop' | 'works-below-model' | 'model-holds';

export function verdictOf(shots: number, wins: number): Verdict {
  if (shots < SHOTS_NEEDED) return 'running';
  if (wins === 0) return 'stop';
  return wins < WINS_FOR_MODEL ? 'works-below-model' : 'model-holds';
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  running: 'Правило ещё считается.',
  stop: 'Побед нет: модель неверна. Останавливаем отправку и решаем, что делать с остатком в кошельке.',
  'works-below-model': 'Схема работает, но заметно хуже модели. Прогноз дохода надо снижать.',
  'model-holds': 'Результат близок к модели. Схема подтверждается.',
};
