import { ApiProperty } from '@nestjs/swagger';

class ChatCompletionMessageDto {
  @ApiProperty({ example: 'assistant' })
  role!: string;

  @ApiProperty({ example: 'Hello! How can I help you today?' })
  content!: string;
}

class ChatCompletionChoiceDto {
  @ApiProperty({ example: 0 })
  index!: number;

  @ApiProperty({ type: ChatCompletionMessageDto })
  message!: ChatCompletionMessageDto;

  @ApiProperty({ type: String, example: 'stop', nullable: true })
  finish_reason!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true, example: null })
  logprobs!: Record<string, unknown> | null;
}

class ChatCompletionUsageDto {
  @ApiProperty({ example: 12 })
  prompt_tokens!: number;

  @ApiProperty({ example: 24 })
  completion_tokens!: number;

  @ApiProperty({ example: 36 })
  total_tokens!: number;
}

/** Documentation model for a non-streaming chat completion response. */
export class ChatCompletionResponseDto {
  @ApiProperty({ example: 'chatcmpl-7f3a2b1c...' })
  id!: string;

  @ApiProperty({ example: 'chat.completion' })
  object!: string;

  @ApiProperty({ example: 1717500000 })
  created!: number;

  @ApiProperty({ example: 'e2ee-qwen3-5-122b-a10b' })
  model!: string;

  @ApiProperty({ type: [ChatCompletionChoiceDto] })
  choices!: ChatCompletionChoiceDto[];

  @ApiProperty({ type: ChatCompletionUsageDto, required: false })
  usage?: ChatCompletionUsageDto;
}
