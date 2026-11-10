/** Шаг задачи из GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs. */
export interface ApiStep {
  name: string;
  status: string; // queued | in_progress | completed | pending | waiting
  conclusion: string | null; // success | failure | cancelled | skipped | neutral | timed_out
  number: number;
}

/** Задача из того же ответа (только нужные поля). */
export interface ApiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  runner_name: string | null;
  steps?: ApiStep[];
}

export type Mark = '⏳' | '✅' | '❌';

export interface StepView {
  name: string;
  mark: Mark;
}

export interface JobView {
  id: number;
  name: string;
  mark: Mark;
  steps: StepView[];
}

/** Шапка сообщения: репозиторий, ветка, авторы. */
export interface Meta {
  /** Заголовок: «Сборка», «Проверка», «Деплой»… */
  title?: string;
  repo: string;
  branch: string;
  authors: string[];
}

export type RunState = 'running' | 'success' | 'failure' | 'cancelled';

export interface Summary {
  state: RunState;
  /** Упавшая задача и шаг (для state === 'failure'). */
  failedJob?: string;
  failedJobId?: number;
  failedStep?: string;
  /** Ссылка прямо на упавший шаг или задачу. */
  failedUrl?: string;
  /** Длительность в секундах (для завершённого запуска). */
  durationSec?: number;
}

export interface Button {
  text: string;
  url: string;
}

/** Ссылки для inline-кнопок. */
export interface Links {
  runUrl: string;
  commitUrl: string;
  prUrl?: string;
  releaseUrl?: string;
}
