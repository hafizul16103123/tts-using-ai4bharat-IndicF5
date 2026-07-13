import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ApiUser, AppConfig } from '../config/configuration';

export interface AuthenticatedRequest extends Request {
  user: ApiUser;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiKey = request.header('x-api-key');
    if (!apiKey) {
      throw new UnauthorizedException('Missing `x-api-key` header.');
    }

    const apiKeys = this.configService.get('apiKeys', { infer: true });
    const user = apiKeys.get(apiKey);
    if (!user) {
      throw new UnauthorizedException('Invalid API key.');
    }

    request.user = user;
    return true;
  }
}
