import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ChatMessageDto } from './chat-message.dto';

/**
 * OpenAI-compatible Chat Completions request body. Only the most common
 * sampling parameters are explicitly modeled; any additional fields are
 * preserved and forwarded upstream to Venice (validation is non-stripping).
 */
export class ChatCompletionRequestDto {
  @ApiProperty({
    description:
      'Model id. Models prefixed with `e2ee-` are routed through the end-to-end encrypted TEE flow.',
    example: 'e2ee-qwen3-5-122b-a10b',
  })
  @IsString()
  model!: string;

  @ApiProperty({
    description: 'The conversation so far.',
    type: [ChatMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];

  @ApiPropertyOptional({
    description:
      'Whether to stream back partial progress as SSE. Note: `e2ee-` models always stream upstream; non-streaming requests are transparently buffered and returned as a single response.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stream?: boolean;

  @ApiPropertyOptional({ description: 'Sampling temperature (0-2).', example: 0.7 })
  @IsOptional()
  @IsNumber()
  temperature?: number;

  @ApiPropertyOptional({ description: 'Nucleus sampling probability mass.', example: 1 })
  @IsOptional()
  @IsNumber()
  top_p?: number;

  @ApiPropertyOptional({ description: 'Maximum number of tokens to generate.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_tokens?: number;

  @ApiPropertyOptional({ description: 'Maximum completion tokens (newer alias of max_tokens).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_completion_tokens?: number;

  @ApiPropertyOptional({ description: 'Number of completions to generate.', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  n?: number;

  @ApiPropertyOptional({ description: 'Penalize new tokens based on presence.', example: 0 })
  @IsOptional()
  @IsNumber()
  presence_penalty?: number;

  @ApiPropertyOptional({ description: 'Penalize new tokens based on frequency.', example: 0 })
  @IsOptional()
  @IsNumber()
  frequency_penalty?: number;

  @ApiPropertyOptional({ description: 'Up to 4 stop sequences.' })
  @IsOptional()
  stop?: string | string[];

  @ApiPropertyOptional({ description: 'A stable identifier for the end-user.' })
  @IsOptional()
  @IsString()
  user?: string;

  @ApiPropertyOptional({ description: 'Venice-specific parameters forwarded upstream.' })
  @IsOptional()
  @IsObject()
  venice_parameters?: Record<string, unknown>;

  // Any other provider-specific fields are preserved by the validation pipe
  // (whitelist is disabled) and forwarded to Venice unchanged.
  [key: string]: unknown;
}
