import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export enum FailedVisitReason {
  RECIPIENT_ABSENT = 'RECIPIENT_ABSENT',
  RECIPIENT_REFUSED = 'RECIPIENT_REFUSED',
}

export class RecordFailedVisitDto {
  @ApiProperty({
    enum: FailedVisitReason,
    description: 'Observed failed-visit reason',
  })
  @IsEnum(FailedVisitReason)
  reason!: FailedVisitReason;

  @ApiProperty({
    maxLength: 500,
    pattern: '\\S',
    description: 'Required nonblank visit context',
  })
  @IsString()
  @Matches(/\S/)
  @MaxLength(500)
  context!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Replay identity; persistence must enforce idempotency',
  })
  @IsUUID()
  requestId!: string;
}
