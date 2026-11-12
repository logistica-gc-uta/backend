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

export class DriverAbsenceSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '2030-02-14', description: 'First absent operational day (America/Guayaquil)' }) startDate!: string;
  @ApiProperty({ example: '2030-02-15', description: 'Last absent operational day, inclusive' }) endDate!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
}

/** Availability of a driver on a specific operational day: holds + compatibility flag + calendar absence (#44). */
export class DriverDayAvailabilityResponseDto extends DriverAvailabilityResponseDto {
  @ApiProperty({ example: '2030-02-14', description: 'Operational day evaluated (America/Guayaquil)' })
  date!: string;

  @ApiProperty({ type: DriverAbsenceSummaryDto, nullable: true, description: 'Active absence covering `date`; while present the driver is not assignable that day' })
  absence!: DriverAbsenceSummaryDto | null;
}
