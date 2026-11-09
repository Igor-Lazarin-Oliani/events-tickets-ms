import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { Activity, buildActivityMessage } from './activity';
import { OutboxMessage } from './entities/outbox-message.entity';

/** Único ponto de acesso à tabela outbox_messages. */
@Injectable()
export class OutboxRepository {
  /** Grava as mensagens na transação recebida: só serão publicadas se a mudança for confirmada. */
  async enqueue(manager: EntityManager, activities: Activity[]): Promise<OutboxMessage[]> {
    if (activities.length === 0) {
      return [];
    }
    const repository = manager.getRepository(OutboxMessage);
    const messages = activities.map((activity) => {
      const payload = buildActivityMessage(activity);
      return repository.create({
        id: payload.message_id,
        routing_key: payload.action,
        payload,
        published_at: null,
      });
    });
    return repository.save(messages);
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
    await manager.getRepository(OutboxMessage).update({ id: In(ids) }, { published_at: new Date() });
  }
}
