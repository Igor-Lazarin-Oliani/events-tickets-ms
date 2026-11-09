import { QueryFailedError } from 'typeorm';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/** Nome da restrição única violada, ou undefined se o erro for de outro tipo. */
export function uniqueViolationConstraint(error: unknown): string | undefined {
  if (error instanceof QueryFailedError) {
    const driverError = error.driverError as { code?: string; constraint?: string };
    if (driverError.code === POSTGRES_UNIQUE_VIOLATION) {
      return driverError.constraint ?? '';
    }
  }
  return undefined;
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
