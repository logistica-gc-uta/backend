import { BadRequestException, Body, Controller, Delete, HttpCode, HttpStatus, Injectable, NestInterceptor, Param, Patch, Post, UploadedFile, UseFilters, UseGuards, UseInterceptors, ExecutionContext, CallHandler } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { catchError, type Observable, throwError } from 'rxjs';
import { Role } from '../../auth/dto/register.dto.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { ShopHttpExceptionFilter, shopError } from '../shop-http.filter.js';
import { AttachImageDto, PatchImageDto, ProductImageResponse, UploadAssetResponse, UploadErrorResponse, UploadFileDto } from './uploads.dto.js';
import { UploadsService } from './uploads.service.js';

const invalidAssociation = { description: 'IMAGE_ASSOCIATION_FAILED: invalid association or attempt to remove/demote the sole published primary; no changes committed', content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadErrorResponse' }, example: { error: { code: 'IMAGE_ASSOCIATION_FAILED', message: 'Image cannot be associated', details: {}, requestId: '00000000-0000-4000-8000-000000000000' } } } } };
const multipart = FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1, fields: 0, parts: 1 } });
@Injectable()
class UploadFileInterceptor implements NestInterceptor {
  private readonly delegate = new multipart();
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    try {
      const result = this.delegate.intercept(context, next);
      return Promise.resolve(result).then(stream => stream.pipe(catchError(error => throwError(() => this.normalize(error)))))
        .catch(error => { throw this.normalize(error); });
    } catch (error) { throw this.normalize(error); }
  }
  private normalize(error: unknown) {
    if (error instanceof BadRequestException && /file too large|limit_file_size/i.test(JSON.stringify(error.getResponse()))) {
      return shopError(413, 'IMAGE_TOO_LARGE', 'Image exceeds 5 MiB');
    }
    return error;
  }
}

@ApiTags('Admin Upload')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@UseFilters(ShopHttpExceptionFilter)
@Controller('admin/catalog')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('uploads')
  @UseInterceptors(UploadFileInterceptor)
  @ApiOperation({ summary: 'Upload decoded image through the backend Cloudinary proxy' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadFileDto })
  @ApiResponse({ status: 201, type: UploadAssetResponse })
  @ApiResponse({ status: 413, type: UploadErrorResponse })
  @ApiResponse({ status: 415, type: UploadErrorResponse })
  @ApiResponse({ status: 502, type: UploadErrorResponse })
  @ApiResponse({ status: 401, type: UploadErrorResponse })
  @ApiResponse({ status: 403, type: UploadErrorResponse })
  upload(@UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined, @CurrentUser('userId') actorId: string) {
    return this.uploads.upload(file, actorId);
  }

  @Post('products/:id/images')
  @ApiOperation({ summary: 'Attach an owned unused upload to a product' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: AttachImageDto })
  @ApiResponse({ status: 201, type: ProductImageResponse })
  @ApiResponse({ status: 422, ...invalidAssociation })
  @ApiResponse({ status: 404, type: UploadErrorResponse })
  @ApiResponse({ status: 401, type: UploadErrorResponse })
  @ApiResponse({ status: 403, type: UploadErrorResponse })
  attach(@Param('id') id: string, @CurrentUser('userId') actorId: string, @Body() dto: AttachImageDto) {
    return this.uploads.attach(id, actorId, dto);
  }

  @Patch('products/:id/images/:imageId')
  @ApiOperation({ summary: 'Update image metadata, primary selection or swap occupied positions' })
  @ApiParam({ name: 'id', format: 'uuid' }) @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiBody({ type: PatchImageDto })
  @ApiResponse({ status: 200, type: ProductImageResponse })
  @ApiResponse({ status: 422, ...invalidAssociation })
  @ApiResponse({ status: 404, type: UploadErrorResponse })
  @ApiResponse({ status: 401, type: UploadErrorResponse })
  @ApiResponse({ status: 403, type: UploadErrorResponse })
  patch(@Param('id') id: string, @Param('imageId') imageId: string, @Body() dto: PatchImageDto) {
    return this.uploads.patch(id, imageId, dto);
  }

  @Delete('products/:id/images/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Detach image; defer provider deletion to audited cleanup' })
  @ApiParam({ name: 'id', format: 'uuid' }) @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Detached' })
  @ApiResponse({ status: 422, ...invalidAssociation })
  @ApiResponse({ status: 404, type: UploadErrorResponse })
  @ApiResponse({ status: 401, type: UploadErrorResponse })
  @ApiResponse({ status: 403, type: UploadErrorResponse })
  detach(@Param('id') id: string, @Param('imageId') imageId: string) {
    return this.uploads.detach(id, imageId);
  }
}
