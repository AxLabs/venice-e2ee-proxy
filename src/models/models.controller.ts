import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ModelsService } from './models.service';
import type { ModelList } from '../common/interfaces/openai.interface';

@ApiTags('Models')
@Controller({ path: 'models', version: '1' })
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Get()
  @ApiOperation({
    summary: 'List models',
    description:
      'Returns the available models in OpenAI list format. Models prefixed with `e2ee-` use the end-to-end encrypted TEE flow.',
  })
  @ApiOkResponse({
    description: 'An OpenAI-compatible list of model objects.',
    schema: {
      example: {
        object: 'list',
        data: [
          {
            id: 'e2ee-qwen3-5-122b-a10b',
            object: 'model',
            created: 1717500000,
            owned_by: 'venice',
          },
        ],
      },
    },
  })
  async listModels(): Promise<ModelList> {
    return this.modelsService.listModels();
  }
}
