import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({
    description: 'Service is up.',
    schema: { example: { status: 'ok', uptime: 12.34 } },
  })
  health(): { status: string; uptime: number } {
    return { status: 'ok', uptime: process.uptime() };
  }
}
