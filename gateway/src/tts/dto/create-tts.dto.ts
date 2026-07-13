import { IsNotEmpty, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

// Max length is enforced in TtsService against the configurable MAX_TEXT_LENGTH env var,
// since class-validator decorators can't read runtime config.
export class CreateTtsDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'text must not be empty.' })
  text!: string;
}
