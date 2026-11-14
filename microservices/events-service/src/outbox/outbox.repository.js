import { Dependencies, Injectable } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, IsNull } from 'typeorm';
import { OutboxMessageEntity } from './entities/outbox-message.entity';

/** Único ponto de acesso à tabela outbox_messages. */
@Injectable()
@Dependencies(getRepositoryToken(OutboxMessageEntity))
export class OutboxRepository {
  constructor(messages) {
    this.messages = messages;
  }

  /**
   * Grava as mensagens ({ exchange, routing_key, payload }) na transação recebida: só serão
   * publicadas se a mudança for confirmada.
   */
  async enqueue(manager, outgoing) {
    if (outgoing.length === 0) {
      return [];
    }
    const repository = manager.getRepository(OutboxMessageEntity);
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
  countPending() {
    return this.messages.count({ where: { published_at: IsNull() } });
  }

  /** Lote de pendentes travado até o commit; outra instância pularia as linhas travadas. */
  lockPending(manager, limit) {
    return manager
      .getRepository(OutboxMessageEntity)
      .createQueryBuilder('message')
      .where('message.published_at IS NULL')
      .orderBy('message.created_at', 'ASC')
      .limit(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
  }

  async markPublished(manager, ids) {
    if (ids.length === 0) {
      return;
    }
    await manager
      .getRepository(OutboxMessageEntity)
      .update({ id: In(ids) }, { published_at: new Date() });
  }
}
