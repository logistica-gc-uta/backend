import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

export class AttachImageDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() uploadId!: string;
  @ApiProperty({ minLength: 1, maxLength: 160 }) @IsString() @MinLength(1) @MaxLength(160) altText!: string;
  @ApiProperty() @IsBoolean() isPrimary!: boolean;
  @ApiProperty({ minimum: 0, maximum: 5 }) @IsInt() @Min(0) @Max(5) position!: number;
}
export class PatchImageDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 160 }) @ValidateIf((_, value) => value !== undefined) @IsString() @MinLength(1) @MaxLength(160) altText?: string;
  @ApiPropertyOptional() @ValidateIf((_, value) => value !== undefined) @IsBoolean() isPrimary?: boolean;
  @ApiPropertyOptional({ minimum: 0, maximum: 5 }) @ValidateIf((_, value) => value !== undefined) @IsInt() @Min(0) @Max(5) position?: number;
}
export class UploadFileDto { @ApiProperty({ type: 'string', format: 'binary' }) file!: unknown }
export class UploadAssetResponse {
  @ApiProperty({ format: 'uuid' }) uploadId!: string;
  @ApiProperty({ format: 'uri' }) secureUrl!: string;
  @ApiProperty() publicId!: string;
  @ApiProperty({ enum: ['jpg', 'png', 'webp'] }) format!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
  @ApiProperty({ enum: ['UPLOADED'] }) status!: 'UPLOADED';
}
export class ProductImageResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uri' }) secureUrl!: string;
  @ApiProperty() publicId!: string;
  @ApiProperty() altText!: string;
  @ApiProperty({ minimum: 0, maximum: 5 }) position!: number;
  @ApiProperty() isPrimary!: boolean;
}
export class UploadErrorResponse {
  @ApiProperty({ type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object', additionalProperties: true }, requestId: { type: 'string' } }, required: ['code', 'message', 'details', 'requestId'] }) error!: object;
}
