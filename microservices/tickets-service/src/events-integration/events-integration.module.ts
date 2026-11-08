import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { EventsClientService } from './events-client.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      useFactory: () => ({
        baseURL: process.env.EVENTS_SERVICE_URL ?? 'http://events-service:8000',
        timeout: Number(process.env.EVENTS_SERVICE_TIMEOUT_MS ?? 5000),
      }),
    }),
  ],
  providers: [EventsClientService],
  exports: [EventsClientService],
})
export class EventsIntegrationModule {}
