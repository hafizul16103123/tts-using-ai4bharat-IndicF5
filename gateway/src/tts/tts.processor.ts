import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Job } from 'bullmq';
import FormData from 'form-data';
import { firstValueFrom } from 'rxjs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfig } from '../config/configuration';
import { formatBangladeshTime, toDurationSeconds } from '../common/time.util';

// In Docker, a container's hostname is its container ID — unique per replica, so this
// doubles as the "which worker handled this job" identity surfaced via job.processedBy.
const WORKER_ID = os.hostname();

export interface TtsJobData {
  text: string;
  userId: string;
}

export interface TtsJobResult {
  path: string;
  bytes: number;
}

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage');

@Processor('tts', {
  concurrency: parseInt(process.env.WORKER_CONCURRENCY ?? '2', 10),
  // Setting this makes BullMQ populate job.processedBy with WORKER_ID automatically.
  name: WORKER_ID,
})
export class TtsProcessor extends WorkerHost {
  private readonly logger = new Logger(TtsProcessor.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {
    super();
  }

  async process(job: Job<TtsJobData>): Promise<TtsJobResult> {
    const { text } = job.data;
    const timeoutMs = this.configService.get('pythonTtsTimeoutMs', { infer: true });
    const pythonTtsUrl = this.configService.get('pythonTtsUrl', { infer: true });
    const startedAt = Date.now();

    this.logger.log(
      JSON.stringify({
        event: 'job_started',
        jobId: job.id,
        workerId: WORKER_ID,
        startedAt: formatBangladeshTime(startedAt),
      }),
    );

    try {
      const form = new FormData();
      form.append('text', text);

      const response = await firstValueFrom(
        this.httpService.post(`${pythonTtsUrl}/tts`, form, {
          headers: form.getHeaders(),
          responseType: 'arraybuffer',
          timeout: timeoutMs,
        }),
      );

      await fs.mkdir(STORAGE_DIR, { recursive: true });
      const filePath = path.join(STORAGE_DIR, `${job.id}.wav`);
      const buffer = Buffer.from(response.data as ArrayBuffer);
      await fs.writeFile(filePath, buffer);

      const finishedAt = Date.now();
      this.logger.log(
        JSON.stringify({
          event: 'job_completed',
          jobId: job.id,
          workerId: WORKER_ID,
          startedAt: formatBangladeshTime(startedAt),
          finishedAt: formatBangladeshTime(finishedAt),
          durationSec: toDurationSeconds(startedAt, finishedAt),
          bytes: buffer.length,
        }),
      );

      return { path: filePath, bytes: buffer.length };
    } catch (error) {
      const finishedAt = Date.now();
      this.logger.error(
        JSON.stringify({
          event: 'job_failed',
          jobId: job.id,
          workerId: WORKER_ID,
          startedAt: formatBangladeshTime(startedAt),
          finishedAt: formatBangladeshTime(finishedAt),
          durationSec: toDurationSeconds(startedAt, finishedAt),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }
}
