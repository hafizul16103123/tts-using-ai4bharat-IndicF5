import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

// A BullMQ worker only needs to consume from Redis — no HTTP listener, so this uses an
// application context instead of a full Nest HTTP app (see main.ts for the API entrypoint).
async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  new Logger('Bootstrap').log('TTS worker started, consuming from the `tts` queue.');
}

bootstrap();
