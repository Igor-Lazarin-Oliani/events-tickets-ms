import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventDto } from './create-event.dto';
import { UpdateEventDto } from './update-event.dto';

const validCreate = {
  title: 'Workshop Docker',
  modality: 'ONLINE',
  location: 'https://example.com/live',
  start_at: '2026-11-20T08:00:00-04:00',
  end_at: '2026-11-20T18:00:00Z',
  max_capacity: 2,
};

async function errorsOf<T extends object>(type: new () => T, body: object): Promise<string[]> {
  const errors = await validate(plainToInstance(type, body));
  return errors.map((error) => error.property).sort();
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

describe('UpdateEventDto', () => {
  it('aceita corpo vazio e null nas colunas opcionais', async () => {
    await expect(errorsOf(UpdateEventDto, {})).resolves.toEqual([]);
    await expect(
      errorsOf(UpdateEventDto, { description: null, metadata_info: null }),
    ).resolves.toEqual([]);
  });

  it('recusa null nas colunas obrigatórias', async () => {
    await expect(
      errorsOf(UpdateEventDto, { title: null, max_capacity: null }),
    ).resolves.toEqual(['max_capacity', 'title']);
  });

  it('recusa status desconhecido', async () => {
    await expect(errorsOf(UpdateEventDto, { status: 'OPEN' })).resolves.toEqual(['status']);
  });
});
