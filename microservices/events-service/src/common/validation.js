import { Body, Query, ValidationPipe } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';

export const Trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

// Diferente de @IsOptional, recusa null: use em colunas obrigatórias de um PUT parcial.
export const IfPresent = () => ValidateIf((_, value) => value !== undefined);

// Mesmas regras do tickets-service: campos desconhecidos respondem 400 (D12).
export const VALIDATION_OPTIONS = { whitelist: true, forbidNonWhitelisted: true, transform: true };

/**
 * Em JavaScript não há metadados de tipo nos parâmetros, e o ValidationPipe global não saberia
 * qual DTO aplicar. Cada corpo e cada query string dizem o DTO explicitamente (D35).
 */
export const ValidBody = (dto) =>
  Body(new ValidationPipe({ ...VALIDATION_OPTIONS, expectedType: dto }));

export const ValidQuery = (dto) =>
  Query(new ValidationPipe({ ...VALIDATION_OPTIONS, expectedType: dto }));
