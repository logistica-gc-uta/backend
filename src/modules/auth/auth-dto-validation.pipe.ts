import {
  ArgumentMetadata,
  BadRequestException,
  PipeTransform,
  ValidationPipe,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';

type AuthDtoClass = new () => object;

function flattenValidationErrors(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...flattenValidationErrors(error.children ?? []),
  ]);
}

/** Auth-local DTO validation: keeps global validation and exception behavior untouched. */
export class AuthDtoValidationPipe implements PipeTransform {
  private readonly validationPipe: ValidationPipe;

  constructor(private readonly dtoClass: AuthDtoClass) {
    this.validationPipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) =>
        new BadRequestException({
          statusCode: 400,
          message: flattenValidationErrors(errors),
          error: 'Bad Request',
          code: 'VALIDATION_ERROR',
        }),
    });
  }

  transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    return this.validationPipe.transform(value, {
      ...metadata,
      metatype: this.dtoClass,
    });
  }
}
