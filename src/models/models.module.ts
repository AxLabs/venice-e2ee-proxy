import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

@Module({
  imports: [CommonModule],
  controllers: [ModelsController],
  providers: [ModelsService],
})
export class ModelsModule {}
