import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { LogsClientService } from './logs-client.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      useFactory: () => ({
        baseURL: process.env.LOGS_SERVICE_URL ?? 'http://logs-service:8000',
        timeout: Number(process.env.LOGS_SERVICE_TIMEOUT_MS ?? 3000),
      }),
    }),
  ],
  providers: [LogsClientService],
  exports: [LogsClientService],
})
export class LogsIntegrationModule {}
