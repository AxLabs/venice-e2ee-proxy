import { Module } from '@nestjs/common';
import { VeniceHttpService } from './venice/venice-http.service';

/** Shared infrastructure providers (upstream HTTP client, etc.). */
@Module({
  providers: [VeniceHttpService],
  exports: [VeniceHttpService],
})
export class CommonModule {}
