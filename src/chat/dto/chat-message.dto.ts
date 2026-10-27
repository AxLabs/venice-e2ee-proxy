import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import type { ChatMessageContent, ToolCallDelta } from '../../common/interfaces/openai.interface';

/**
 * A single chat message. Mirrors the OpenAI message object. `content` accepts
 * a string, the structured array form, or null when the assistant turn is only
 * a tool call. Tool-result bodies are encrypted; tool names, ids, and
 * arguments are forwarded in the clear.
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
    description:
      'The message content. A string, an array of content parts, or null when an assistant message is only a tool call.',
    nullable: true,
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
    example: 'Hello!',
  })
  @IsOptional()
  content?: ChatMessageContent;

  @ApiPropertyOptional({ description: 'Optional name of the message author.' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Id of the tool call a `tool` message answers.',
  })
  @IsOptional()
  @IsString()
  tool_call_id?: string;

  @ApiPropertyOptional({
    description:
      'Tool calls emitted by an assistant message. Names, ids, and arguments stay plaintext.',
    type: 'array',
    items: { type: 'object' },
  })
  @IsOptional()
  @IsArray()
  tool_calls?: ToolCallDelta[];
}
