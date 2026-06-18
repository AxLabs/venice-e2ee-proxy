import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { E2eeService } from './e2ee.service';

/**
 * Encapsulates all interaction with the `@axlabs/venice-e2ee` library so the rest of
 * the application depends only on `E2eeService`.
 */
@Module({
  imports: [CommonModule],
  providers: [E2eeService],
  exports: [E2eeService],
})
export class E2eeModule {}
