import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsOptional, IsString } from 'class-validator';
import type { ChatMessageContent } from '../../common/interfaces/openai.interface';

/**
 * A single chat message. Mirrors the OpenAI message object. `content` accepts
 * either a plain string or the structured array form; both are normalized to
 * text before encryption.
 */
export class ChatMessageDto {
  @ApiProperty({
    description: 'The role of the message author.',
    enum: ['system', 'user', 'assistant', 'tool', 'function'],
    example: 'user',
  })
  @IsString()
  role!: string;

  @ApiProperty({
    description: 'The message content. A string, or an array of content parts.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
    example: 'Hello!',
  })
  @IsDefined()
  content!: ChatMessageContent;

  @ApiPropertyOptional({ description: 'Optional name of the message author.' })
  @IsOptional()
  @IsString()
  name?: string;
}
