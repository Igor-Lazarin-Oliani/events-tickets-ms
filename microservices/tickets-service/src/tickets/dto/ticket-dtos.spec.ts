import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTicketDto } from './create-ticket.dto';
import { UpdateTicketDto } from './update-ticket.dto';

const validCreate = {
  event_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  participant_name: 'Maria Silva',
  participant_email: 'maria@example.com',
  participant_document: '2026123456',
};

async function errorsOf<T extends object>(type: new () => T, body: object): Promise<string[]> {
  const errors = await validate(plainToInstance(type, body));
  return errors.map((error) => error.property);
}

describe('CreateTicketDto', () => {
  it('aceita um corpo válido', async () => {
    await expect(errorsOf(CreateTicketDto, validCreate)).resolves.toEqual([]);
  });

  it('recusa UUID, e-mail e documento em branco', async () => {
    const errors = await errorsOf(CreateTicketDto, {
      ...validCreate,
      event_id: 'abc',
      participant_email: 'sem-arroba',
      participant_document: '   ',
    });

    expect(errors.sort()).toEqual(['event_id', 'participant_document', 'participant_email']);
  });

  it('remove espaços do documento, para não burlar a duplicidade', () => {
    const dto = plainToInstance(CreateTicketDto, {
      ...validCreate,
      participant_document: ' 123 ',
    });

    expect(dto.participant_document).toBe('123');
  });
});

describe('UpdateTicketDto', () => {
  it('aceita check-in e corpo vazio', async () => {
    await expect(errorsOf(UpdateTicketDto, { status: 'CHECKED_IN' })).resolves.toEqual([]);
    await expect(errorsOf(UpdateTicketDto, {})).resolves.toEqual([]);
  });

  it.each(['CANCELLED', 'CONFIRMED'])('recusa status %s', async (status) => {
    await expect(errorsOf(UpdateTicketDto, { status })).resolves.toEqual(['status']);
  });

  it('recusa null em campo obrigatório', async () => {
    await expect(errorsOf(UpdateTicketDto, { participant_name: null })).resolves.toEqual([
      'participant_name',
    ]);
  });
});
