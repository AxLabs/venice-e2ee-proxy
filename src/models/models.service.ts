import { Injectable, Logger } from '@nestjs/common';
import { VeniceHttpService } from '../common/venice/venice-http.service';
import type { ModelList, ModelObject } from '../common/interfaces/openai.interface';
import { isE2EEModel } from '../common/utils/openai.util';

/** Fetches and normalizes the upstream Venice model catalog. */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(private readonly venice: VeniceHttpService) {}

  /**
   * Returns the OpenAI-compatible `{ object: "list", data: [...] }` model list
   * from Venice. The upstream already returns an OpenAI-shaped payload; we pass
   * it through, guarding against unexpected shapes.
   */
  async listModels(): Promise<ModelList> {
    this.logger.debug('Fetching model catalog from Venice');
    const response = await this.venice.get('/models');
    if (!response.ok) {
      await this.venice.throwUpstreamError(response, 'list models');
    }

    const payload = (await response.json()) as Partial<ModelList> | undefined;
    const data = Array.isArray(payload?.data) ? (payload!.data as ModelObject[]) : [];

    // Surface the E2EE-capable model IDs: clients like Cline's "OpenAI
    // Compatible" provider don't render a model picker, so users must type the
    // model ID by hand. Listing them here gives a copy-paste-ready reference.
    const e2eeIds = data.map((model) => model.id).filter((id) => isE2EEModel(id));
    this.logger.log(`Returning ${data.length} model(s); ${e2eeIds.length} E2EE-capable`);
    if (e2eeIds.length > 0) {
      this.logger.log(`E2EE model IDs (type one into your client): ${e2eeIds.join(', ')}`);
    }

    return {
      object: 'list',
      data,
    };
  }
}
