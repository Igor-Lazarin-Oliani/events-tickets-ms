import { BadRequestException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidBody } from '../../common/validation';
import { CreateEventDto } from './create-event.dto';
import { ListEventsQueryDto } from './list-events-query.dto';
import { ReserveSpotDto } from './reserve-spot.dto';
import { UpdateEventDto } from './update-event.dto';

const validCreate = {
  title: 'Workshop Docker',
  modality: 'ONLINE',
  location: 'https://example.com/live',
  start_at: '2026-11-20T08:00:00-04:00',
  end_at: '2026-11-20T18:00:00Z',
  max_capacity: 2,
};

async function errorsOf(type, body) {
  const errors = await validate(plainToInstance(type, body));
  return errors.map((error) => error.property).sort();
}

/** Pipe que o ValidBody associa ao parâmetro, como o NestJS o executa. */
function bodyPipe(dto) {
  const decorate = ValidBody(dto);
  class Probe {
    handler() {}
  }
  decorate(Probe.prototype, 'handler', 0);
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler');
  return Object.values(args)[0].pipes[0];
}

describe('CreateEventDto', () => {
  it('aceita um corpo válido, com fuso em offset ou Z', async () => {
    await expect(errorsOf(CreateEventDto, validCreate)).resolves.toEqual([]);
  });

  it('recusa data sem fuso horário (D10)', async () => {
    await expect(
      errorsOf(CreateEventDto, { ...validCreate, start_at: '2026-11-20T08:00:00' }),
    ).resolves.toEqual(['start_at']);
  });

  it('recusa capacidade zero, modalidade desconhecida e título em branco', async () => {
    await expect(
      errorsOf(CreateEventDto, { ...validCreate, max_capacity: 0, modality: 'X', title: '  ' }),
    ).resolves.toEqual(['max_capacity', 'modality', 'title']);
  });
});

describe('ValidBody', () => {
  const metadata = { type: 'body' };

  it('valida o corpo com o DTO informado, sem metadados de tipo do TypeScript (D35)', async () => {
    const pipe = bodyPipe(CreateEventDto);

    const dto = await pipe.transform({ ...validCreate, title: '  Workshop  ' }, metadata);

    expect(dto).toBeInstanceOf(CreateEventDto);
    expect(dto.title).toBe('Workshop');
  });

  it('responde 400 a campos desconhecidos (D12)', async () => {
    const pipe = bodyPipe(CreateEventDto);

    await expect(pipe.transform({ ...validCreate, extra: 1 }, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('responde 400 a corpo inválido', async () => {
    const pipe = bodyPipe(ReserveSpotDto);

    await expect(pipe.transform({ ticket_id: 'abc' }, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('ListEventsQueryDto', () => {
  it('converte limit e offset da query string em números', async () => {
    const query = plainToInstance(ListEventsQueryDto, { limit: '10', offset: '20' });

    await expect(validate(query)).resolves.toEqual([]);
    expect([query.limit, query.offset]).toEqual([10, 20]);
  });

  it.each(['0', '501', 'abc', '2.5'])('recusa limit=%s', async (limit) => {
    await expect(errorsOf(ListEventsQueryDto, { limit })).resolves.toEqual(['limit']);
  });

  it('recusa offset negativo', async () => {
    await expect(errorsOf(ListEventsQueryDto, { offset: '-1' })).resolves.toEqual(['offset']);
  });
});

describe('UpdateEventDto', () => {
  it('aceita corpo vazio e null nas colunas opcionais', async () => {
    await expect(errorsOf(UpdateEventDto, {})).resolves.toEqual([]);
    await expect(
      errorsOf(UpdateEventDto, { description: null, metadata_info: null }),
    ).resolves.toEqual([]);
  });

  it('recusa null nas colunas obrigatórias', async () => {
    await expect(errorsOf(UpdateEventDto, { title: null, max_capacity: null })).resolves.toEqual([
      'max_capacity',
      'title',
    ]);
  });

  it('recusa status desconhecido', async () => {
    await expect(errorsOf(UpdateEventDto, { status: 'OPEN' })).resolves.toEqual(['status']);
  });
});

describe('ReserveSpotDto', () => {
  it('exige ticket_id em formato UUID', async () => {
    await expect(errorsOf(ReserveSpotDto, { ticket_id: 'abc' })).resolves.toEqual(['ticket_id']);
    await expect(
      errorsOf(ReserveSpotDto, { ticket_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }),
    ).resolves.toEqual([]);
  });
});
