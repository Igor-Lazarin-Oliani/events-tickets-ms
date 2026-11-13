import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// Mesmos limites do GET /logs, para as listagens dos dois serviços se comportarem igual.
export const MAX_PAGE_LIMIT = 500;
export const DEFAULT_LIST_LIMIT = 100;
export const TOTAL_COUNT_HEADER = 'X-Total-Count';

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

/** limit e offset de uma listagem; a query string chega como texto e é convertida em número. */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export function pageRequest(query: PaginationQueryDto, defaultLimit: number): PageRequest {
  return { limit: query.limit ?? defaultLimit, offset: query.offset ?? 0 };
}

/** Documenta limit e offset no Swagger. */
export function ApiPagination(defaultLimit: number) {
  return applyDecorators(
    ApiQuery({
      name: 'limit',
      required: false,
      description: `Quantidade máxima de itens (1 a ${MAX_PAGE_LIMIT}).`,
      schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT, default: defaultLimit },
    }),
    ApiQuery({
      name: 'offset',
      required: false,
      description: 'Quantos itens pular, para buscar as páginas seguintes.',
      schema: { type: 'integer', minimum: 0, default: 0 },
    }),
  );
}

/** Cabeçalho com o total de itens que atendem aos filtros, sem a paginação. */
export const TOTAL_COUNT_RESPONSE_HEADER = {
  [TOTAL_COUNT_HEADER]: {
    description: 'Total de itens que atendem aos filtros, sem considerar limit e offset.',
    schema: { type: 'integer', example: 1 },
  },
};
