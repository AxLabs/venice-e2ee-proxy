import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { E2eeModule } from './e2ee/e2ee.module';
import { HealthController } from './health/health.controller';
import { ModelsModule } from './models/models.module';

@Module({
  imports: [ConfigModule, CommonModule, E2eeModule, ChatModule, ModelsModule],
  controllers: [HealthController],
})
export class AppModule {}
