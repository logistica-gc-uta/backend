import { ApiProperty } from '@nestjs/swagger';
import { Role } from './register.dto.js';

export class AuthUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: Role })
  role!: Role;
}

export class RegisterResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: [Role.CLIENT], example: Role.CLIENT })
  role!: Role.CLIENT;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'JWT de acceso' })
  access_token!: string;

  @ApiProperty({ type: AuthUserResponseDto })
  user!: AuthUserResponseDto;
}

export class AuthErrorResponseDto {
  @ApiProperty({ enum: [400, 401, 409] })
  statusCode!: number;

  @ApiProperty({
    oneOf: [
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
    ],
  })
  message!: string | string[];

  @ApiProperty({ enum: ['Bad Request', 'Unauthorized', 'Conflict'] })
  error!: string;

  @ApiProperty({
    enum: ['VALIDATION_ERROR', 'INVALID_CREDENTIALS', 'EMAIL_ALREADY_EXISTS'],
  })
  code!: string;
}
