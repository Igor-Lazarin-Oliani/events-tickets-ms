import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';

export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

// Diferente de @IsOptional, recusa null: use em colunas obrigatórias de um PUT parcial.
export const IfPresent = () => ValidateIf((_, value: unknown) => value !== undefined);
