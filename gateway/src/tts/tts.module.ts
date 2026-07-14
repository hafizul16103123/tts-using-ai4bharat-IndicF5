import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { UserThrottlerGuard } from '../common/user-throttler.guard';
import { AppConfig } from '../config/configuration';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';

// This is the API/producer side: it registers the queue to enqueue and query jobs, but
// does not run TtsProcessor. The processor lives in WorkerModule so the two tiers (cheap,
// stateless HTTP handling vs. the actual inference-dispatching bottleneck) can be scaled
// independently — see worker.module.ts and docker-compose.scale.yml.
@Module({
  imports: [
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
    AuthModule,
  ],
  controllers: [TtsController],
  providers: [TtsService, UserThrottlerGuard],
})
export class TtsModule {}
