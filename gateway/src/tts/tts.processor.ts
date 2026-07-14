import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Job } from 'bullmq';
import FormData from 'form-data';
import { firstValueFrom } from 'rxjs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { AppConfig } from '../config/configuration';

export interface TtsJobData {
  text: string;
  userId: string;
}

export interface TtsJobResult {
  path: string;
  bytes: number;
}

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage');

@Processor('tts', { concurrency: parseInt(process.env.WORKER_CONCURRENCY ?? '2', 10) })
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

    const form = new FormData();
    form.append('text', text);

    this.logger.log(`Job ${job.id}: sending ${text.length} chars to Python backend`);

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

    this.logger.log(`Job ${job.id}: wrote ${buffer.length} bytes to ${filePath}`);

    return { path: filePath, bytes: buffer.length };
  }
}
