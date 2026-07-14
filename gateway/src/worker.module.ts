import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration, { AppConfig } from './config/configuration';
import { TtsProcessor } from './tts/tts.processor';

// The consumer side of the 'tts' queue — no HTTP surface at all, just a BullMQ worker.
// Runs as its own process (worker.main.ts) so it can be scaled independently of the
// stateless API tier (app.module.ts / main.ts). See docker-compose.scale.yml.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => ({
        connection: {
          host: configService.get('redisHost', { infer: true }),
          port: configService.get('redisPort', { infer: true }),
        },
      }),
    }),
    BullModule.registerQueueAsync({
      name: 'tts',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => ({
        connection: {
          host: configService.get('redisHost', { infer: true }),
          port: configService.get('redisPort', { infer: true }),
        },
      }),
    }),
    HttpModule,
  ],
  providers: [TtsProcessor],
})
export class WorkerModule {}
