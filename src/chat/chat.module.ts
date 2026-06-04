import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { E2eeModule } from '../e2ee/e2ee.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [CommonModule, E2eeModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
