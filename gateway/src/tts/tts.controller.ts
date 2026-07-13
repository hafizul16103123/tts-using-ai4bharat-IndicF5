import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UserThrottlerGuard } from '../common/user-throttler.guard';
import { ApiUser } from '../config/configuration';
import { CreateTtsDto } from './dto/create-tts.dto';
import { TtsService } from './tts.service';

// Guard order matters: ApiKeyGuard must run first so it populates req.user before
// UserThrottlerGuard reads it to key the rate limit per API key instead of per IP.
@Controller('tts')
@UseGuards(ApiKeyGuard, UserThrottlerGuard)
export class TtsController {
  constructor(private readonly ttsService: TtsService) {}

  // Rate-limited using the global ThrottlerModule config (RATE_LIMIT_MAX / RATE_LIMIT_TTL_MS),
  // keyed per API key by UserThrottlerGuard. GET routes below opt out via @SkipThrottle so
  // polling doesn't count against it.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  submit(@Body() dto: CreateTtsDto, @CurrentUser() user: ApiUser) {
    return this.ttsService.submit(dto.text, user);
  }

  @Get(':jobId')
  @SkipThrottle()
  getStatus(@Param('jobId') jobId: string, @CurrentUser() user: ApiUser) {
    return this.ttsService.getStatus(jobId, user);
  }

  @Get(':jobId/audio')
  @SkipThrottle()
  async getAudio(
    @Param('jobId') jobId: string,
    @CurrentUser() user: ApiUser,
    @Res() res: Response,
  ) {
    const audio = await this.ttsService.getAudio(jobId, user);
    res.set({ 'Content-Type': 'audio/wav', 'Content-Length': audio.length });
    res.send(audio);
  }
}
