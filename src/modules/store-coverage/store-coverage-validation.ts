import { HttpStatus, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { shopError } from '../shop/shop-http.filter.js';

function collectPaths(errors: ValidationError[], prefix = ''): string[] {
  const paths: string[] = [];
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    paths.push(path);
    if (error.children?.length) {
      paths.push(...collectPaths(error.children, path));
    }
  }
  return paths;
}

export function storeCoverageExceptionFactory(errors: ValidationError[]) {
  const paths = collectPaths(errors);
  const locationHit = paths.some(
    (path) => path === 'lat' || path === 'lng' || path === 'location' || path.startsWith('location.'),
  );
  const coverageHit = paths.some((path) => path === 'coverage' || path.startsWith('coverage.'));
  if (locationHit && !coverageHit) {
    return shopError(
      HttpStatus.BAD_REQUEST,
      'STORE_LOCATION_INVALID',
      'Store or point coordinates must be finite WGS84 latitude and longitude',
    );
  }
  if (coverageHit && !locationHit) {
    return shopError(HttpStatus.BAD_REQUEST, 'STORE_COVERAGE_INVALID', 'Coverage polygon is invalid');
  }
  return shopError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Invalid request');
}

export const storeCoverageValidationPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  exceptionFactory: storeCoverageExceptionFactory,
});
