import { ApiProperty } from '@nestjs/swagger';

export class DriverAvailabilityResponseDto {
  @ApiProperty({
    type: Boolean,
    description:
      'Assignable only when persisted holds are absent and compatibility availability is verified',
  })
  isAvailable!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'Whether persisted reservation or lifecycle records block reuse',
  })
  hasPersistedHolds!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'Compatibility flag is false or unavailable; not a fabricated route state',
  })
  compatibilityFlagBlocks!: boolean;

  @ApiProperty({
    type: [String],
    description: 'Blocking current or unresolved legacy route identifiers',
  })
  blockingRouteIds!: string[];
}
