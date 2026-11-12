import { ApiProperty } from '@nestjs/swagger';

export class AdminClientItemDto {
  @ApiProperty({
    description: 'Unique identifier of the registered CLIENT user',
    example: '00000000-0000-4000-8000-000000000001',
  })
  id: string;

  @ApiProperty({
    description: 'Display name of the registered CLIENT user',
    example: 'Ana Cliente',
  })
  name: string;

  @ApiProperty({
    description: 'Normalized email address of the registered CLIENT user',
    example: 'client1@delivery.com',
    format: 'email',
  })
  email: string;
}

export class AdminClientsPageDto {
  @ApiProperty({
    description: 'Registered CLIENT users matching the query for the current page',
    type: () => [AdminClientItemDto],
  })
  items: AdminClientItemDto[];

  @ApiProperty({
    description: 'Total number of registered CLIENT users matching the filter',
    type: Number,
    example: 2,
  })
  total: number;

  @ApiProperty({
    description: 'Current 1-based page number',
    type: Number,
    minimum: 1,
    default: 1,
    example: 1,
  })
  page: number;

  @ApiProperty({
    description: 'Maximum number of items per page',
    type: Number,
    minimum: 1,
    maximum: 50,
    default: 20,
    example: 20,
  })
  pageSize: number;
}
