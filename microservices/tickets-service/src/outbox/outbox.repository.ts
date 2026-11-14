import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Repository } from 'typeorm';
import { OutgoingMessage } from './activity';
import { OutboxMessage } from './entities/outbox-message.entity';

/** Único ponto de acesso à tabela outbox_messages. */
@Injectable()
export class OutboxRepository {
  constructor(
    @InjectRepository(OutboxMessage) private readonly messages: Repository<OutboxMessage>,
  ) {}

  /** Grava as mensagens na transação recebida: só serão publicadas se a mudança for confirmada. */
  async enqueue(manager: EntityManager, outgoing: OutgoingMessage[]): Promise<OutboxMessage[]> {
    if (outgoing.length === 0) {
      return [];
    }
    const repository = manager.getRepository(OutboxMessage);
    const rows = outgoing.map((message) =>
      repository.create({
        id: message.payload.message_id,
        exchange: message.exchange,
        routing_key: message.routing_key,
        payload: message.payload,
        published_at: null,
      }),
    );
    return repository.save(rows);
  }

  /** Total aguardando publicação; usa o índice de published_at. */
  countPending(): Promise<number> {
    return this.messages.count({ where: { published_at: IsNull() } });
  }

  /** Lote de pendentes travado até o commit; outra instância pularia as linhas travadas. */
  lockPending(manager: EntityManager, limit: number): Promise<OutboxMessage[]> {
    return manager
      .getRepository(OutboxMessage)
      .createQueryBuilder('message')
      .where('message.published_at IS NULL')
      .orderBy('message.created_at', 'ASC')
      .limit(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
  }

  async markPublished(manager: EntityManager, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await manager.getRepository(OutboxMessage).update({ id: In(ids) }, { published_at: new Date() });
  }
}
