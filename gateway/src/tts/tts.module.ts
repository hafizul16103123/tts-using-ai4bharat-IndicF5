import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { UserThrottlerGuard } from '../common/user-throttler.guard';
import { AppConfig } from '../config/configuration';
import { TtsController } from './tts.controller';
import { TtsProcessor } from './tts.processor';
import { TtsService } from './tts.service';

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
    HttpModule,
    AuthModule,
  ],
  controllers: [TtsController],
  providers: [TtsService, TtsProcessor, UserThrottlerGuard],
})
export class TtsModule {}
