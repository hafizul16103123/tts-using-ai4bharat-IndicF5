import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { ApiUser, AppConfig } from '../config/configuration';
import { TtsJobData, TtsJobResult } from './tts.processor';

export type JobStatus = 'queued' | 'active' | 'completed' | 'failed';

export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

@Injectable()
export class TtsService {
  constructor(
    @InjectQueue('tts') private readonly queue: Queue<TtsJobData, TtsJobResult>,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  async submit(text: string, user: ApiUser): Promise<{ jobId: string }> {
    const maxTextLength = this.configService.get('maxTextLength', { infer: true });
    if (text.length > maxTextLength) {
      throw new BadRequestException(
        `text exceeds the maximum allowed length of ${maxTextLength} characters.`,
      );
    }

    const maxQueueSize = this.configService.get('maxQueueSize', { infer: true });
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    const inFlight = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    if (inFlight >= maxQueueSize) {
      throw new HttpException(
        'The synthesis queue is currently full. Please try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const jobId = uuidv4();
    await this.queue.add(
      'synthesize',
      { text, userId: user.id },
      {
        jobId,
        attempts: 1,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 3600 },
      },
    );

    return { jobId };
  }

  async getStatus(jobId: string, user: ApiUser): Promise<JobStatusResponse> {
    const job = await this.findOwnedJob(jobId, user);
    const state = await job.getState();

    const status: JobStatus =
      state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'active' ? 'active' : 'queued';

    return {
      jobId: job.id!,
      status,
      error: status === 'failed' ? job.failedReason : undefined,
      createdAt: job.timestamp,
      completedAt: job.finishedOn,
    };
  }

  async getAudio(jobId: string, user: ApiUser): Promise<Buffer> {
    const job = await this.findOwnedJob(jobId, user);
    const state = await job.getState();

    if (state === 'failed') {
      throw new ConflictException(`Job ${jobId} failed: ${job.failedReason ?? 'unknown error'}`);
    }
    if (state !== 'completed') {
      throw new ConflictException(`Job ${jobId} is not finished yet (status: ${state}).`);
    }
    if (!job.returnvalue) {
      throw new InternalServerErrorException('Job completed without a stored result.');
    }

    try {
      return await fs.readFile(job.returnvalue.path);
    } catch {
      throw new InternalServerErrorException('Stored audio result is no longer available.');
    }
  }

  private async findOwnedJob(jobId: string, user: ApiUser) {
    const job = await this.queue.getJob(jobId);
    if (!job || job.data.userId !== user.id) {
      // 404 (not 403) so a foreign jobId doesn't confirm its existence to a non-owner.
      throw new NotFoundException(`No job found with id ${jobId}.`);
    }
    return job;
  }
}
